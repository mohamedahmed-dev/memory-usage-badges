import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Increased update interval to reduce CPU load
const UPDATE_INTERVAL_MS = 5000; // Changed from 2500 to 5000 (5 seconds)
const MEMORY_THRESHOLD_RED_MB = 2048;

// Cache for process relationships to avoid rescanning /proc every time
const PROCESS_CACHE_DURATION_MS = 20000; // Cache for 20 seconds (increased from 10s)
let processCache = new Map();
let processCacheTime = 0;

// Limits to spread work across frames
const MAX_PROCESSES_PER_IDLE = 10; // Process max 10 processes per idle callback
const MAX_APPS_PER_FRAME = 3; // Update max 3 apps per frame

function getProcessCgroup(pid) {
    try {
        const [success, contents] = GLib.file_get_contents(`/proc/${pid}/cgroup`);
        if (!success) return null;

        const text = new TextDecoder('utf-8').decode(contents);
        const lines = text.split('\n');

        for (let line of lines)
 {
            if (line.startsWith('0::')) {
                return line.substring(3);
            }
        }

        if (lines.length > 0 && lines[0].includes(':')) {
            const parts = lines[0].split(':');
            if (parts.length >= 3) return parts[2];
        }

        return null;
    } catch (e) {
        return null;
    }
}

function getProcessExePath(pid) {
    try {
        const file = GLib.file_new_for_path(`/proc/${pid}/exe`);
        const info = file.query_info('standard::symlink-target',
                                     GLib.FileQueryInfoFlags.NONE, null);
        return info.get_symlink_target();
    } catch (e) {
        return null;
    }
}

function getParentPid(pid) {
    try {
        const [success, contents] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!success) return null;

        const text = new TextDecoder('utf-8').decode(contents);
        const parts = text.split(')');

        if (parts.length > 1) {
            const fields = parts[1].trim().split(/\s+/);
            const ppid = parseInt(fields[1], 10);
            return ppid > 0 ? ppid : null;
        }

        return null;
    } catch (e) {
        return null;
    }
}

function getRelatedProcesses(basePids) {
    // Use cached result if still valid
    const cacheKey = basePids.sort((a, b) => a - b).join(',');
    const now = Date.now();

    if (now - processCacheTime < PROCESS_CACHE_DURATION_MS && processCache.has(cacheKey)) {
        return processCache.get(cacheKey);
    }

    const relatedPids = new Set(basePids);
    const processedPids = new Set();
    const cgroupMap = new Map();
    const exeMap = new Map();

    // Build cgroup and exe maps for base pids
    for (let pid of basePids) {
        const cgroup = getProcessCgroup(pid);
        const exe = getProcessExePath(pid);
        if (cgroup) cgroupMap.set(pid, cgroup);
        if (exe) exeMap.set(pid, exe);
    }

    try {
        const procDir = GLib.Dir.open('/proc', 0);
        let name;
        let processCount = 0;

        while ((name = procDir.read_name()) !== null) {
            if (!/^\d+$/.test(name)) continue;

            const pid = parseInt(name, 10);
            if (processedPids.has(pid) || relatedPids.has(pid)) continue;

            processedPids.add(pid);
            processCount++;

            // Hard limit: stop scanning after checking enough processes
            if (processCount >= 100) {
                break;
            }

            let isRelated = false;

            // Check cgroup relationship
            const pidCgroup = getProcessCgroup(pid);
            if (pidCgroup) {
                for (let baseCgroup of cgroupMap.values()) {
                    if (pidCgroup === baseCgroup || pidCgroup.startsWith(baseCgroup + '/')) {
                        isRelated = true;
                        break;
                    }
                }
            }

            // Check executable path relationship
            if (!isRelated) {
                const pidExe = getProcessExePath(pid);
                if (pidExe) {
                    for (let baseExe of exeMap.values()) {
                        if (pidExe === baseExe) {
                            isRelated = true;
                            break;
                        }
                    }
                }
            }

            // Check parent relationship (limited depth to avoid deep scans)
            if (!isRelated) {
                let currentPid = pid;
                const visited = new Set();

                for (let i = 0; i < 5 && currentPid; i++) { // Reduced from 10 to 5
                    if (visited.has(currentPid)) break;
                    visited.add(currentPid);

                    if (relatedPids.has(currentPid)) {
                        isRelated = true;
                        break;
                    }

                    currentPid = getParentPid(currentPid);
                }
            }

            if (isRelated) {
                relatedPids.add(pid);
            }
        }
    } catch (e) {
        // /proc not accessible
    }

    const result = Array.from(relatedPids);

    // Update cache
    processCache.set(cacheKey, result);
    processCacheTime = now;

    // Clear old cache entries to prevent memory leak
    if (processCache.size > 50) {
        const firstKey = processCache.keys().next().value;
        processCache.delete(firstKey);
    }

    return result;
}

function getProcessMemory(pid) {
    try {
        const [smapsSuccess, smapsContents] = GLib.file_get_contents(`/proc/${pid}/smaps_rollup`);
        if (smapsSuccess) {
            const text = new TextDecoder('utf-8').decode(smapsContents);
            const pssMatch = text.match(/Pss:\s+(\d+)\s+kB/);
            if (pssMatch) return parseInt(pssMatch[1], 10);
        }

        const [success, contents] = GLib.file_get_contents(`/proc/${pid}/status`);
        if (!success) return 0;

        const text = new TextDecoder('utf-8').decode(contents);
        const vmRssMatch = text.match(/VmRSS:\s+(\d+)\s+kB/);
        if (vmRssMatch) return parseInt(vmRssMatch[1], 10);

        return 0;
    } catch (e) {
        return 0;
    }
}

function getAppMemory(app) {
    const basePids = app.get_pids();
    if (basePids.length === 0) return 0;

    const allPids = getRelatedProcesses(basePids);
    let totalMemoryKB = 0;

    for (let pid of allPids) {
        totalMemoryKB += getProcessMemory(pid);
    }

    return totalMemoryKB;
}

function formatMemoryCompact(memoryKB) {
    if (memoryKB === 0) return '';

    const memoryMB = memoryKB / 1024;

    if (memoryMB < 1024) {
        return memoryMB < 10 ? `${memoryMB.toFixed(1)}M` : `${Math.round(memoryMB)}M`;
    }

    const memoryGB = memoryMB / 1024;
    return memoryGB < 10 ? `${memoryGB.toFixed(1)}G` : `${Math.round(memoryGB)}G`;
}

function isHighMemory(memoryKB) {
    return (memoryKB / 1024) >= MEMORY_THRESHOLD_RED_MB;
}

export default class OverviewAppMemoryExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._memoryBadges = null;
        this._updateTimeoutId = null;
        this._originalAppIconInit = null;
        this._isUpdating = false;
        this._updateQueue = [];
        this._updateQueueProcessing = false;
        this._appMemoryCache = new Map();
    }

    enable() {
        this._memoryBadges = new Map();
        this._patchAppIcon();
        this._startUpdates();
    }

    disable() {
        this._stopUpdates();
        this._cleanupBadges();
        this._unpatchAppIcon();
        this._memoryBadges = null;
        this._updateTimeoutId = null;
        this._originalAppIconInit = null;
        this._updateQueue = [];
        this._updateQueueProcessing = false;
        this._appMemoryCache = null;

        // Clear caches on disable
        processCache.clear();
        processCacheTime = 0;
    }

    _patchAppIcon() {
        this._originalAppIconInit = AppDisplay.AppIcon.prototype._init;
        const originalInit = this._originalAppIconInit;
        const memoryBadges = this._memoryBadges;

        AppDisplay.AppIcon.prototype._init = function(app, iconParams) {
            originalInit.call(this, app, iconParams);
            _attachMemoryBadge(this, memoryBadges);
        };
    }

    _unpatchAppIcon() {
        if (this._originalAppIconInit) {
            AppDisplay.AppIcon.prototype._init = this._originalAppIconInit;
            this._originalAppIconInit = null;
        }
    }

    _startUpdates() {
        // Initial update
        this._scheduleUpdate();

        // Schedule periodic updates with LOW priority to avoid interfering with user input
        this._updateTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_LOW, // Changed from PRIORITY_DEFAULT to PRIORITY_LOW
            UPDATE_INTERVAL_MS,
            () => {
                this._scheduleUpdate();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _scheduleUpdate() {
        // Skip if already updating to prevent overlapping updates
        if (this._isUpdating) {
            return;
        }

        // Only update when overview is visible to save resources
        if (!Main.overview.visible) {
            return;
        }

        this._isUpdating = true;

        // Build queue of apps to update
        const appSystem = Shell.AppSystem.get_default();
        const runningApps = appSystem.get_running();
        this._updateQueue = Array.from(runningApps);
        this._updateQueueProcessing = false;
this._appMemoryCache.clear();
        
        // Start processing queue in chunks
        this._processUpdateQueue();
    }

    _processUpdateQueue() {
        if (this._updateQueue.length === 0) {
            // All apps processed, now update all badges
            this._updateAllBadges();
            this._isUpdating = false;
            this._updateQueueProcessing = false;
            return;
        }

        this._updateQueueProcessing = true;

        // Process small batch of apps per frame
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const batch = this._updateQueue.splice(0, MAX_APPS_PER_FRAME);

            // Calculate memory for this batch and store in cache
            for (let app of batch) {
                const memoryKB = getAppMemory(app);
                this._appMemoryCache.set(app, memoryKB);
            }

            // Schedule next batch
            if (this._updateQueue.length > 0) {
                this._processUpdateQueue();
            } else {
                // All apps processed, now update all badges
                this._updateAllBadges();
                this._isUpdating = false;
                this._updateQueueProcessing = false;
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    _updateAllBadges() {
        for (let [icon, badge] of this._memoryBadges.entries()) {
            try {
                const app = icon.app;
                if (!app) {
                    badge.hide();
                    continue;
                }

                const memoryKB = this._appMemoryCache.get(app) || 0;
                const formattedMemory = formatMemoryCompact(memoryKB);

                if (formattedMemory) {
                    badge.text = formattedMemory;
                    badge.remove_style_class_name('memory-high');

                    if (isHighMemory(memoryKB)) {
                        badge.add_style_class_name('memory-high');
                    }

                    badge.show();
                } else {
                    badge.hide();
                }
            } catch (e) {
                badge.hide();
            }
        }
    }

    _stopUpdates() {
        if (this._updateTimeoutId) {
            GLib.Source.remove(this._updateTimeoutId);
            this._updateTimeoutId = null;
        }
    }

    _cleanupBadges() {
        for (let [icon, badge] of this._memoryBadges.entries()) {
            try {
                if (badge && !badge.is_finalized) {
                    icon.remove_child(badge);
                    badge.destroy();
                }
            } catch (e) {
                // Icon or badge may already be destroyed
            }
        }
        this._memoryBadges.clear();
    }
}

function _attachMemoryBadge(icon, memoryBadges) {
    if (memoryBadges.has(icon)) return;

    const badge = new St.Label({
        style_class: 'app-memory-badge',
        text: '',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.END,
        x_expand: false,
        y_expand: false,
    });

    badge.hide();

    if (icon._iconBin) {
        icon.add_child(badge);

        const allocationId = badge.connect('notify::allocation', () => {
            if (icon._iconBin) {
                const [binWidth, binHeight] = icon._iconBin.get_size();
                const [badgeWidth, badgeHeight] = badge.get_size();

                badge.set_position(
                    icon._iconBin.x + (binWidth - badgeWidth) / 2,
                    icon._iconBin.y - badgeHeight - 4
                );
            }
        });

        badge._allocationSignalId = allocationId;
    } else {
        icon.add_child(badge);
    }

    memoryBadges.set(icon, badge);

    const destroyId = icon.connect('destroy', () => {
        if (memoryBadges.has(icon)) {
            const badgeToRemove = memoryBadges.get(icon);
            memoryBadges.delete(icon);
            if (badgeToRemove && !badgeToRemove.is_finalized) {
                if (badgeToRemove._allocationSignalId) {
                    badgeToRemove.disconnect(badgeToRemove._allocationSignalId);
                    badgeToRemove._allocationSignalId = null;
                }
                badgeToRemove.destroy();
            }
        }
        if (destroyId) {
            icon.disconnect(destroyId);
        }
    });
}
