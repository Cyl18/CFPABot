// Global functions accessible from loaded tool files
window.addToast = function (message, type = 'INFO', duration = 5000) {
    window.dispatchEvent(new CustomEvent('add-toast', {
        detail: { message, type, duration }
    }));
};

window.openCriticalModal = function () {
    window.dispatchEvent(new CustomEvent('open-critical-modal'));
};

// Main App State
function appData() {
    // Pre-check cookie to set initial state - prevents login screen flash
    var hasCookie = document.cookie.split(';').some(cookie => cookie.trim().startsWith('oauth-token-enc='));

    return {
        activeSection: 'Dashboard',
        activeTool: 'Overview',
        isLoggedIn: hasCookie, // Optimistically set to true if cookie exists
        isCheckingAuth: true,
        isAdmin: false,
        githubUser: { login: '', avatar_url: '' },

        // Helper function to check if cookie exists
        hasCookie(name) {
            return document.cookie.split(';').some(cookie => cookie.trim().startsWith(name + '='));
        },

        // Helper function to delete cookie
        deleteCookie(name) {
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
        },

        // Authentication methods
        checkAuthStatus() {
            // Check if auth state was already fetched by the early request in app.js
            if (window.__AUTH_STATE__) {
                this.isCheckingAuth = window.__AUTH_STATE__.isCheckingAuth;
                this.isLoggedIn = window.__AUTH_STATE__.isLoggedIn;
                this.githubUser = window.__AUTH_STATE__.githubUser;
                this.isAdmin = window.__AUTH_STATE__.isAdmin;

                // If still checking, set up a watcher to sync when complete
                if (this.isCheckingAuth) {
                    const checkInterval = setInterval(() => {
                        if (!window.__AUTH_STATE__.isCheckingAuth) {
                            this.isCheckingAuth = false;
                            this.isLoggedIn = window.__AUTH_STATE__.isLoggedIn;
                            this.githubUser = window.__AUTH_STATE__.githubUser;
                            this.isAdmin = window.__AUTH_STATE__.isAdmin;
                            clearInterval(checkInterval);

                            // Wait for DOM update, then re-init icons and check preloader
                            this.$nextTick(() => {
                                if (typeof lucide !== 'undefined' && lucide.createIcons) {
                                    lucide.createIcons();
                                }
                                setTimeout(() => {
                                    if (window.checkAndRemovePreloader) {
                                        window.checkAndRemovePreloader();
                                    }
                                }, 100);
                            });
                        }
                    }, 50);
                } else {
                    // Auth already complete, trigger preloader check
                    this.$nextTick(() => {
                        if (typeof lucide !== 'undefined' && lucide.createIcons) {
                            lucide.createIcons();
                        }
                        setTimeout(() => {
                            if (window.checkAndRemovePreloader) {
                                window.checkAndRemovePreloader();
                            }
                        }, 100);
                    });
                }
                return;
            }

            // Fallback: Manual check if early request hasn't started yet
            this.isCheckingAuth = true;
            // First check if cookie exists
            if (!this.hasCookie('oauth-token-enc')) {
                console.log('No oauth-token-enc cookie found');
                this.isLoggedIn = false;
                this.isAdmin = false;
                this.isCheckingAuth = false;

                // Trigger preloader check after state update
                setTimeout(() => {
                    if (window.checkAndRemovePreloader) {
                        window.checkAndRemovePreloader();
                    }
                }, 100);
                return;
            }

            // Check if user is authenticated via backend and get all user info
            fetch(window.API_BASE_URL + '/UserStatus', {
                credentials: 'include' // Important: send cookies
            })
                .then(res => {
                    if (res.ok) {
                        return res.json();
                    }
                    throw new Error('Not authenticated');
                })
                .then(data => {
                    // Check if response indicates an error
                    if (data.isError === true) {
                        throw new Error('API returned error');
                    }

                    this.isLoggedIn = true;
                    this.githubUser = {
                        login: data.userName || 'User',
                        avatar_url: data.avatarUrl || ''
                    };
                    this.isAdmin = data.isAdmin === true;
                    this.isCheckingAuth = false;

                    // Re-initialize icons and check preloader after DOM updates
                    this.$nextTick(() => {
                        if (typeof lucide !== 'undefined' && lucide.createIcons) {
                            lucide.createIcons();
                        }
                        setTimeout(() => {
                            if (window.checkAndRemovePreloader) {
                                window.checkAndRemovePreloader();
                            }
                        }, 100);
                    });
                })
                .catch(err => {
                    console.log('Not authenticated:', err);
                    this.isLoggedIn = false;
                    this.isAdmin = false;
                    this.isCheckingAuth = false;

                    // Delay to ensure x-show directive has taken effect
                    setTimeout(() => {
                        if (window.checkAndRemovePreloader) {
                            window.checkAndRemovePreloader();
                        }
                    }, 50);
                });
        },

        logout() {
            // Clear cookie
            this.deleteCookie('oauth-token-enc');

            // Clear local state
            this.isLoggedIn = false;
            this.isAdmin = false;
            this.githubUser = { login: '', avatar_url: '' };

            this.addToast('Logged out successfully', 'INFO', 2000);

            // Redirect to login page
            setTimeout(() => {
                window.location.href = 'login.html';
            }, 500);
        },

        sections: [
            { id: 'Dashboard', label: 'Dashboard', icon: 'layout-dashboard' },
            { id: 'Utilities', label: 'Utilities', icon: 'wrench' },
            { id: 'Review', label: 'Review', icon: 'clipboard-check' },
            { id: 'Settings', label: 'Settings', icon: 'settings' },
            { id: 'ZhuZhu', label: '给大家看🐖', icon: 'piggy-bank', toolId: 'Zhu Tool' },
        ],
        toolsMap: {
            'Dashboard': [
                { id: 'Overview', label: 'Overview', icon: 'activity' },
                { id: 'Analytics', label: 'Analytics', icon: 'bar-chart-2' }
            ],
            'Utilities': [
                { id: 'Text Transformer', label: 'Text Transformer', icon: 'type' },
                { id: 'JSON Viewer', label: 'JSON Viewer', icon: 'file-json' },
                { id: 'Color Picker', label: 'Color Picker', icon: 'palette' }
            ],
            'Review': [
                { id: 'PR Review', label: 'PR Review', icon: 'git-pull-request' }
            ],
            'Settings': [
                { id: 'Profile', label: 'Profile', icon: 'user' },
                { id: 'Preferences', label: 'Preferences', icon: 'sliders' }
            ],
        },

        getTools(section) {
            return this.toolsMap[section] || [];
        },

        // Router: Parse current URL hash into section and tool
        parseRoute() {
            const hash = window.location.hash.slice(1); // Remove '#'
            if (!hash || hash === '/') {
                return { section: 'Dashboard', tool: 'Overview' };
            }

            // Expected format: #/section or #/section/tool
            const parts = hash.split('/').filter(p => p);
            if (parts.length === 0) {
                return { section: 'Dashboard', tool: 'Overview' };
            }

            // Normalize section name (dashboard -> Dashboard)
            const sectionName = parts[0].split('-').map(w =>
                w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
            ).join(' ');

            // Find matching section
            const section = this.sections.find(s =>
                s.id.toLowerCase() === sectionName.toLowerCase()
            );

            if (!section) {
                return { section: 'Dashboard', tool: 'Overview' };
            }

            // If section is a direct tool (has toolId and it's not null)
            if ('toolId' in section && section.toolId !== null) {
                return { section: section.id, tool: section.toolId };
            }

            // Parse tool name if provided
            if (parts.length > 1) {
                const toolName = parts.slice(1).join(' ').split('-').map(w =>
                    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
                ).join(' ');

                const tools = this.getTools(section.id);
                const tool = tools.find(t =>
                    t.id.toLowerCase() === toolName.toLowerCase()
                );

                if (tool) {
                    return { section: section.id, tool: tool.id };
                }
            }

            // Default to first tool in section
            const tools = this.getTools(section.id);
            return {
                section: section.id,
                tool: tools.length > 0 ? tools[0].id : 'Overview'
            };
        },

        // Router: Navigate to a specific route
        navigateToRoute(section, tool, updateHistory = true) {
            // Update active states
            this.activeSection = section;
            this.activeTool = tool;

            // Load the tool content
            this.loadTool(tool);

            // Update URL hash if needed
            if (updateHistory) {
                const sectionSlug = section.toLowerCase().replace(/\s+/g, '-');
                const toolSlug = tool.toLowerCase().replace(/\s+/g, '-');
                // For direct tools, only include section in URL
                const sectionObj = this.sections.find(s => s.id === section);
                const isDirectTool = sectionObj && 'toolId' in sectionObj && sectionObj.toolId !== null;
                const hash = isDirectTool ? `#/${sectionSlug}` : `#/${sectionSlug}/${toolSlug}`;
                window.location.hash = hash;
            }
        },

        // Router: Initialize routing system
        initRouter() {
            // Parse initial route from URL
            const route = this.parseRoute();
            this.navigateToRoute(route.section, route.tool, false);

            // Listen for hash changes (browser back/forward)
            window.addEventListener('hashchange', () => {
                const route = this.parseRoute();
                this.navigateToRoute(route.section, route.tool, false);
            });
        },

        // Load tool dynamically via HTMX
        loadTool(toolId) {
            // toolId could be null for placeholder pages
            const toolFileMap = {
                'Overview': 'tools/overview.html',
                'Analytics': 'tools/analytics.html',
                'Text Transformer': 'tools/text-transformer.html',
                'PR Review': 'tools/pr-review.html',
                'Zhu Tool': 'tools/zhuzhu.html'
            };

            const toolFile = toolFileMap[toolId] || 'tools/default-placeholder.html';

            // Use HTMX to load the tool with optimized swap timing
            htmx.ajax('GET', toolFile, {
                target: '#tool-content',
                swap: 'innerHTML swap:20ms settle:20ms' // Delay swap and settle to reduce flicker
            }).then(() => {
                // Re-initialize Lucide icons immediately after content is loaded
                if (typeof lucide !== 'undefined' && lucide.createIcons) {
                    lucide.createIcons(); // Immediate call
                    setTimeout(() => lucide.createIcons(), 10); // Quick retry
                }
            });
        },

        // Toast Logic
        toasts: [],
        addToast(message, type = 'INFO', duration = 5000) {
            const id = Date.now() + Math.random().toString(36).substr(2, 9);
            this.toasts.push({ id, message, type, duration });
            // Provide Lucide icons for new elements
            this.$nextTick(() => lucide.createIcons());
        },
        removeToast(id) {
            this.toasts = this.toasts.filter(t => t.id !== id);
        },

        // Modal Logic
        modal: {
            isOpen: false,
            title: '',
            content: ''
        },
        openModal(title, contentHtml) {
            this.modal.title = title;
            this.modal.content = contentHtml;
            this.modal.isOpen = true;
            this.$nextTick(() => lucide.createIcons());
        },
        closeModal() {
            this.modal.isOpen = false;
            setTimeout(() => {
                this.modal.title = '';
                this.modal.content = '';
            }, 200);
        },
        openCriticalModal() {
            this.openModal(
                "Critical System Action",
                `
                <div class="space-y-4">
                    <div class="p-4 bg-red-900/20 border border-red-900/50 rounded-lg flex items-start gap-3">
                        <i data-lucide="alert-octagon" class="w-6 h-6 text-red-500 flex-shrink-0"></i>
                        <div>
                            <h4 class="font-bold text-red-400">Warning: Irreversible Action</h4>
                            <p class="text-sm text-red-200/70 mt-1">
                                You are about to purge the local cache. This cannot be undone and might log you out of active sessions.
                            </p>
                        </div>
                    </div>
                    <p class="text-slate-300">
                        Please confirm that you understand the risks associated with this operation. 
                        The system will reboot services immediately after confirmation.
                    </p>
                </div>
                `
            );
        },

        // Listen for global events from loaded tools
        init() {
            // Check authentication on page load
            this.checkAuthStatus();

            // Initialize router system
            this.initRouter();

            // Trigger preloader check after init completes
            this.$nextTick(() => {
                setTimeout(() => {
                    if (window.checkAndRemovePreloader) {
                        window.checkAndRemovePreloader();
                    }
                }, 100);
            });

            window.addEventListener('add-toast', (e) => {
                this.addToast(e.detail.message, e.detail.type, e.detail.duration);
            });
            window.addEventListener('open-critical-modal', () => {
                this.openCriticalModal();
            });
        }
    }
}

// Individual Toast Logic (Pause on hover)
function toastItem(toastData) {
    return {
        show: false,
        isPaused: false,
        progress: 100,
        interval: null,
        totalTime: toastData.duration,
        remainingTime: toastData.duration,

        initTimer() {
            this.show = true;
            this.startCountdown();
        },

        startCountdown() {
            const tickRate = 100; // Update every 100ms
            const decrement = (tickRate / this.totalTime) * 100;

            this.interval = setInterval(() => {
                if (!this.isPaused) {
                    this.progress -= decrement;
                    if (this.progress <= 0) {
                        this.close();
                    }
                }
            }, tickRate);
        },

        pauseTimer() {
            this.isPaused = true;
        },

        resumeTimer() {
            this.isPaused = false;
        },

        close() {
            clearInterval(this.interval);
            this.show = false;
            // Wait for transition to finish before dispatching remove event
            setTimeout(() => {
                this.$dispatch('remove-toast', { id: toastData.id });
            }, 300);
        }
    }
}
// Start checking authentication as soon as DOM is ready
document.addEventListener('DOMContentLoaded', function () {
    if (window.__ALPINE_INSTANCE__) {
        window.__ALPINE_INSTANCE__.checkAuthStatus();
    }
});

// Alpine initialization callback
document.addEventListener('alpine:init', function () {
    // Alpine is initializing
    // Ensure Lucide is rendered after Alpine initializes
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons();
    }
});

// When DOM content is loaded, ensure Lucide is initialized again
document.addEventListener('DOMContentLoaded', function () {
    // Retry Lucide initialization in case it wasn't ready before
    setTimeout(function () {
        if (typeof lucide !== 'undefined' && lucide.createIcons) {
            lucide.createIcons();
        }
    }, 100);

    // Try to get the Alpine app instance and start auth check early
    // This allows checking auth while external scripts like Tailwind, HTMX, Lucide are still loading
    if (window.__ALPINE_INSTANCE__) {
        window.__ALPINE_INSTANCE__.checkAuthStatus();
    }
});

// Also setup a global reference for Alpine to use after it initializes
document.addEventListener('alpine:init', function () {
    // Alpine is initializing, will call init() which calls checkAuthStatus()
});

// Listen for HTMX content swaps to reinitialize Lucide icons
document.body.addEventListener('htmx:afterSwap', function (event) {
    // Reinitialize Lucide icons immediately after swap
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
        lucide.createIcons(); // Immediate call
        setTimeout(lucide.createIcons, 10); // Quick retry for any delayed elements
    }
});