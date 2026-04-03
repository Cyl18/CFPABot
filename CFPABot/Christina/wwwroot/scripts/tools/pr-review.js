function prReviewData() {
  return {
    prNumber: '',
    selectedMod: '',
    importanceLevel: 'medium',
    mods: [],
    modsLoading: false,
    models: [],
    consistencyEnabled: false,
    consistencyScope: 'diff_only',
    consistencyModel: '',
    
    loading: false,
    loadingForce: false,
    ws: null,
    statusMessage: '',
    perModelProgress: [],
    result: null,
    history: [],
    historyLoading: false,
    historyVisible: false,

    async init() {
      const urlParams = new URLSearchParams(window.location.search);
      const prParam = urlParams.get('pr');
      const modParam = urlParams.get('mod');
      const reviewHashParam = urlParams.get('review');

      // Restore basic settings from localStorage
      const savedImportance = localStorage.getItem('prReview_importanceLevel');
      if (savedImportance) this.importanceLevel = savedImportance;
      
      const savedConsistencyEnabled = localStorage.getItem('prReview_consistencyEnabled');
      if (savedConsistencyEnabled !== null) this.consistencyEnabled = savedConsistencyEnabled === 'true';
      
      const savedConsistencyScope = localStorage.getItem('prReview_consistencyScope');
      if (savedConsistencyScope) this.consistencyScope = savedConsistencyScope;
      
      const savedConsistencyModel = localStorage.getItem('prReview_consistencyModel');
      if (savedConsistencyModel) this.consistencyModel = savedConsistencyModel;

      try {
        const res = await fetch(window.API_BASE_URL + '/ModelConfigs', { credentials: 'include' });
        if(res.ok) {
          const data = await res.json();
          let allModels = [];
          
          // Restore selected models from localStorage
          const savedModelsStr = localStorage.getItem('prReview_enabledModels');
          const savedModels = savedModelsStr ? JSON.parse(savedModelsStr) : null;
          
          if(data.globalPresets) {
            allModels = allModels.concat(data.globalPresets.map(x => {
              const modelIdStr = x.provider + ':' + x.modelId;
              const enabled = savedModels ? savedModels.includes(modelIdStr) : true;
              return { ...x, isGlobal: true, enabled };
            }));
          }
          if(data.userModels) {
            allModels = allModels.concat(data.userModels.map(x => {
              const modelIdStr = x.provider + ':' + x.modelId;
              const enabled = savedModels ? savedModels.includes(modelIdStr) : false;
              return { ...x, isGlobal: false, enabled };
            }));
          }
          this.models = allModels;
        }
      } catch (e) {
        console.error('Failed to load models:', e);
      }

      // Sync settings to localStorage on change
      this.$watch('importanceLevel', val => localStorage.setItem('prReview_importanceLevel', val));
      this.$watch('consistencyEnabled', val => localStorage.setItem('prReview_consistencyEnabled', val));
      this.$watch('consistencyScope', val => localStorage.setItem('prReview_consistencyScope', val));
      this.$watch('consistencyModel', val => localStorage.setItem('prReview_consistencyModel', val));
      this.$watch('models', val => {
        const enabledModels = val.filter(m => m.enabled).map(m => m.provider + ':' + m.modelId);
        localStorage.setItem('prReview_enabledModels', JSON.stringify(enabledModels));
      }, { deep: true });

      if (prParam) {
        this.prNumber = prParam;
        await this.loadMods(modParam);
      } else if (modParam) {
        this.selectedMod = modParam;
      }

      if (reviewHashParam) {
        await this.loadHistoryCacheEntry(reviewHashParam, false);
      } else if (this.prNumber || this.selectedMod) {
        this.updateShareUrl();
      }

      // Cleanup WS on page unload
      window.addEventListener('beforeunload', () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        }
      });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    getCookie(name) {
      const v = document.cookie.match('(^|;) ?' + name + '=([^;]*)(;|$)');
      return v ? decodeURIComponent(v[2]) : null;
    },

    updateShareUrl(reviewHash = null) {
      const url = new URL(window.location.href);

      if (this.prNumber) url.searchParams.set('pr', this.prNumber);
      else url.searchParams.delete('pr');

      if (this.selectedMod) url.searchParams.set('mod', this.selectedMod);
      else url.searchParams.delete('mod');

      if (reviewHash) url.searchParams.set('review', reviewHash);
      else url.searchParams.delete('review');

      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextUrl !== currentUrl) {
        window.history.replaceState({}, '', nextUrl);
      }
    },

    async loadMods(preferredMod = null) {
      if (!this.prNumber) return;
      this.modsLoading = true;
      this.mods = [];
      this.selectedMod = '';
      try {
        const res = await fetch(`${window.API_BASE_URL}/PRMods?pr=${this.prNumber}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const list = data.mods || data.Mods || data || [];
          this.mods = Array.isArray(list) ? list : [];
          if (preferredMod && this.mods.includes(preferredMod)) {
            this.selectedMod = preferredMod;
          } else if (this.mods.length === 1) {
            this.selectedMod = this.mods[0];
          } else if (preferredMod) {
            this.selectedMod = preferredMod;
          }
          if (this.selectedMod) await this.loadHistory();
        }
      } catch(e) {
        console.error('Failed to load mods:', e);
      } finally {
        this.modsLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    async loadHistory() {
      if (!this.prNumber || !this.selectedMod) return;
      this.historyLoading = true;
      this.history = [];
      try {
        const res = await fetch(`${window.API_BASE_URL}/PRReviewHistory?pr=${this.prNumber}&mod=${encodeURIComponent(this.selectedMod)}`, { credentials: 'include' });
        if (res.ok) {
          this.history = await res.json();
        }
      } catch(e) {
        console.error('Failed to load history:', e);
      } finally {
        this.historyLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    async loadHistoryCacheEntry(hash, updateUrl = true) {
      try {
        const res = await fetch(`${window.API_BASE_URL}/PRReviewCacheEntry?hash=${encodeURIComponent(hash)}`, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          this.result = data.result;
          this.historyVisible = false;
          if (updateUrl) this.updateShareUrl(hash);
          this.$nextTick(() => window.lucide && window.lucide.createIcons());
        } else {
          console.error('Failed to load cache entry:', res.status);
        }
      } catch(e) {
        console.error('Failed to load cache entry:', e);
      }
    },

    loadReview(force) {
      if(!this.prNumber || !this.selectedMod) return;
      
      this.loading = true;
      this.loadingForce = !!force;
      this.result = null;
      this.perModelProgress = [];
      this.statusMessage = 'Connecting...';
      this.historyVisible = false;
      this.updateShareUrl();

      if(this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }

      let baseWsUrl = window.API_BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');
      let url = `${baseWsUrl}/ws/PRLLMReviewResult?pr=${this.prNumber}&mod=${encodeURIComponent(this.selectedMod)}&importance=${this.importanceLevel}`;
      if(force) url += '&force=true';

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.statusMessage = this.consistencyEnabled ? 'Connected. Preparing consistency check...' : 'Connected. Starting review...';
        
        let perModelOverrides = {};
        const enabledModels = this.models.filter(x => x.enabled);
        const overrideModels = [...enabledModels];
        if (this.consistencyEnabled && this.consistencyModel) {
          const consistencySpec = this.models.find(m => (m.provider + ':' + m.modelId) === this.consistencyModel);
          if (consistencySpec && !overrideModels.some(m => (m.provider + ':' + m.modelId) === this.consistencyModel)) {
            overrideModels.push(consistencySpec);
          }
        }
        
        if (typeof window.loadApiKey === 'function') {
            overrideModels.forEach(m => {
                const uniqueId = m.provider + ':' + m.modelId;
                const key = window.loadApiKey(uniqueId) || window.loadApiKey(m.provider + ':*');
                // Always include baseUrl for custom models (even if no API key required)
                const needsEntry = key || (m.provider === 'custom' && m.baseUrl);
                if (needsEntry) {
                    perModelOverrides[uniqueId] = {};
                    if (key) perModelOverrides[uniqueId].apiKey = key;
                    if (m.baseUrl) perModelOverrides[uniqueId].baseUrl = m.baseUrl;
                }
            });
        }

        const msg = {
          token: this.getCookie('oauth-token-enc') || '',
          models: enabledModels.map(x => x.provider + ':' + x.modelId),
          perModelOverrides: perModelOverrides,
          consistency: this.consistencyEnabled,
          consistencyScope: this.consistencyScope,
          consistencyModel: this.consistencyModel
        };
        
        this.ws.send(JSON.stringify(msg));
      };

      this.ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          
          if (data.type === 'progress') {
            if (data.perModel) {
              this.perModelProgress = data.perModel;
              const activeConsistency = data.perModel.find(p =>
                p.stage === 'consistency' && (p.indeterminate || (p.completed || 0) < (p.total || 0))
              );
              const merging = data.perModel.some(p => p.merging);
              const reviewProgress = data.perModel.filter(p => p.stage !== 'consistency');
              const done = reviewProgress.reduce((s, p) => s + (p.completed || 0), 0);
              const total = reviewProgress.reduce((s, p) => s + (p.total || 0), 0);

              if (activeConsistency) {
                this.statusMessage = activeConsistency.statusText || 'Running consistency check...';
              } else if (merging) {
                this.statusMessage = 'Merging results...';
              } else if (reviewProgress.length > 0) {
                this.statusMessage = `Processing... ${done}/${total}`;
              } else if (data.perModel.some(p => p.stage === 'consistency')) {
                this.statusMessage = 'Consistency check complete. Starting review...';
              } else {
                this.statusMessage = 'Preparing review...';
              }
            }
          } else if (data.type === 'done') {
            this.result = data.result;
            this.updateShareUrl(data.hash || null);
            this.statusMessage = 'Done.';
            this.loading = false;
            this.loadingForce = false;
            this.perModelProgress = [];
            this.ws.close();
          } else if (data.type === 'error') {
            console.error('Error from WS:', data.message);
            this.statusMessage = 'Error: ' + data.message;
            this.loading = false;
            this.loadingForce = false;
            this.perModelProgress = [];
            this.ws.close();
          }
        } catch(err) {
          console.error('Parse WS message error:', err);
        }
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      };

      this.ws.onerror = (e) => {
        console.error('WS Error:', e);
        this.statusMessage = 'WebSocket Error occurred.';
        this.loading = false;
        this.loadingForce = false;
        this.perModelProgress = [];
      };

      this.ws.onclose = () => {
        if(this.loading) { // closed unexpectedly
            this.statusMessage = 'Connection closed unexpectedly.';
            this.loading = false;
            this.loadingForce = false;
            this.perModelProgress = [];
        }
      };
    },

    cancelReview() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'cancel' }));
        this.statusMessage = 'Cancelling...';
      }
    },

    getStatusSeverity(statusStr) {
      switch(statusStr) {
        case 'NotReviewed': return -1;
        case 'Pass': return 0;
        case 'Minor': return 1;
        case 'NeedsContext': return 2;
        case 'NeedsFix': return 3;
        default: return 0;
      }
    },

    getAggregatedStatus(rowId) {
      if(!this.result || !this.result.modelResults) return 0;
      let maxSeverity = 0;
      let hasUnreviewed = false;
      this.result.modelResults.forEach(mr => {
        const item = mr.items?.find(x => x.id === rowId);
        if(!item) {
          hasUnreviewed = true;
        } else if(item.status === 'NotReviewed') {
          hasUnreviewed = true;
        } else {
          const s = this.getStatusSeverity(item.status);
          if(s > maxSeverity) maxSeverity = s;
        }
      });
      return maxSeverity === 0 && hasUnreviewed ? -1 : maxSeverity;
    },

    getAggregatedStatusText(rowId) {
      return this.getStatusText(this.getAggregatedStatus(rowId));
    },

    getAggregatedStatusClass(rowId) {
      return this.getStatusClass(this.getAggregatedStatus(rowId));
    },

    getStatusText(severity) {
      switch(severity) {
        case -1: return 'Not Reviewed';
        case 0: return 'Pass';
        case 1: return 'Minor';
        case 2: return 'Needs Context';
        case 3: return 'Needs Fix';
        default: return 'Unknown';
      }
    },

    getStatusClass(severity) {
      switch(severity) {
        case -1: return 'bg-slate-200 text-slate-900 dark:bg-slate-600 dark:text-slate-100';
        case 0: return 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300';
        case 1: return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300';
        case 2: return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300';
        case 3: return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
        default: return 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300';
      }
    },

    formatMarkdown(text) {
      if (!text) return '';
      if (typeof window.marked !== 'undefined') {
        return window.marked.parse(text);
      }
      return text.replace(/\n/g, '<br>');
    }
  };
}