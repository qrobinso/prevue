import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  getChannels,
  deleteChannel,
  updateChannel,
  createChannel,
  createAIChannel,
  refreshAIChannel,
  getAIConfig,
  updateAIConfig,
  getAISuggestions,
  getChannelPresets,
  getSelectedPresets,
  generateChannels,
  getSettings,
  updateSettings,
  type ChannelWithProgram,
  type ChannelPresetData,
  type ChannelPreset,
  type AIConfig,
} from '../../services/api';
import { wsClient } from '../../services/websocket';

type ViewMode = 'presets' | 'list' | 'ai';

function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PRESET_MULTIPLIER_STORAGE_KEY = 'prevue_preset_multipliers';
const MULTIPLIER_OPTIONS = [1, 2, 3, 4] as const;

function loadSavedMultipliers(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PRESET_MULTIPLIER_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    }
  } catch {
    // ignore
  }
  return {};
}

function saveMultipliers(m: Record<string, number>) {
  try {
    localStorage.setItem(PRESET_MULTIPLIER_STORAGE_KEY, JSON.stringify(m));
  } catch {
    // ignore
  }
}

interface GenerationProgress {
  step: string;
  message: string;
  current?: number;
  total?: number;
}

interface AICreationResult {
  channelName: string;
  description: string;
  itemCount: number;
}

export default function ChannelSettings() {
  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [presetData, setPresetData] = useState<ChannelPresetData | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(new Set());
  const [presetMultipliers, setPresetMultipliers] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState('');
  const [savingOrder, setSavingOrder] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('presets');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [separateContentTypes, setSeparateContentTypes] = useState(true);
  const [scheduleAutoUpdateEnabled, setScheduleAutoUpdateEnabled] = useState(true);
  const [scheduleAutoUpdateHours, setScheduleAutoUpdateHours] = useState(4);
  const separateLoadedRef = useRef(false);
  const [draggingChannelId, setDraggingChannelId] = useState<number | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<number | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);

  const [refreshingChannelId, setRefreshingChannelId] = useState<number | null>(null);

  // AI state
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [aiKeyInput, setAiKeyInput] = useState('');
  const [aiModelInput, setAiModelInput] = useState('');
  const [aiConfigSaving, setAiConfigSaving] = useState(false);
  const [aiConfigExpanded, setAiConfigExpanded] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiCreating, setAiCreating] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiResult, setAiResult] = useState<AICreationResult | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);

  // Subscribe to WebSocket for progress updates
  useEffect(() => {
    // Ensure WebSocket is connected
    wsClient.connect();

    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type === 'generation:progress') {
        setGenerationProgress(event.payload as GenerationProgress);
      }
    });

    return unsubscribe;
  }, []);

  const loadData = async () => {
    try {
      const [channelsData, aiConfigData, presetsData, savedPresets, settingsData] = await Promise.all([
        getChannels(),
        getAIConfig().catch(() => null),
        getChannelPresets(),
        getSelectedPresets().catch(() => []),
        getSettings().catch(() => ({})),
      ]);
      setChannels(channelsData);
      if (aiConfigData) {
        setAiConfig(aiConfigData);
        setAiModelInput(aiConfigData.model);
        // Auto-expand config section if no key is configured
        if (!aiConfigData.hasKey) {
          setAiConfigExpanded(true);
        }
      }
      setPresetData(presetsData);
      if (!separateLoadedRef.current) {
        const settings = settingsData as Record<string, unknown>;
        setSeparateContentTypes(settings['separate_content_types'] !== false);
        const hoursSetting = settings['schedule_auto_update_hours'];
        const parsedHours = typeof hoursSetting === 'number' && Number.isFinite(hoursSetting)
          ? Math.floor(hoursSetting)
          : 4;
        setScheduleAutoUpdateEnabled(settings['schedule_auto_update_enabled'] !== false);
        setScheduleAutoUpdateHours(Math.max(1, Math.min(168, parsedHours)));
        separateLoadedRef.current = true;
      }
      const savedSet = new Set(savedPresets);
      setSelectedPresets(savedSet);
      // Derive multipliers from saved list when expanded (duplicates present); else use saved/localStorage
      const fromServer: Record<string, number> = {};
      for (const id of savedPresets) {
        fromServer[id] = (fromServer[id] ?? 0) + 1;
      }
      const hasExpanded = savedPresets.length > savedSet.size;
      const savedMultipliers = loadSavedMultipliers();
      const multipliers = hasExpanded
        ? fromServer
        : { ...savedMultipliers, ...Object.fromEntries([...savedSet].map(id => [id, savedMultipliers[id] ?? 1])) };
      setPresetMultipliers(multipliers);

      // Expand all categories by default
      setExpandedCategories(new Set(presetsData.categories.map(c => c.id)));
    } catch {
      // Handle error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleDelete = async (id: number) => {
    try {
      await deleteChannel(id);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRefreshAI = async (id: number) => {
    try {
      setRefreshingChannelId(id);
      setError('');
      await refreshAIChannel(id);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshingChannelId(null);
    }
  };

  const reorderChannelsById = useCallback((list: ChannelWithProgram[], sourceId: number, targetId: number) => {
    if (sourceId === targetId) return list;
    const fromIdx = list.findIndex(ch => ch.id === sourceId);
    const toIdx = list.findIndex(ch => ch.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return list;
    const reordered = [...list];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    return reordered;
  }, []);

  const persistChannelOrder = useCallback(async (reordered: ChannelWithProgram[]) => {
    setSavingOrder(true);
    setError('');
    try {
      await Promise.all(
        reordered.map((ch, idx) =>
          updateChannel(ch.id, { sort_order: idx + 1 })
        )
      );
      await loadData();
    } catch (err) {
      setError((err as Error).message);
      await loadData();
    } finally {
      setSavingOrder(false);
    }
  }, []);

  const handleDragStart = useCallback((channelId: number, e: React.PointerEvent<HTMLButtonElement>) => {
    if (savingOrder) return;
    dragPointerIdRef.current = e.pointerId;
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setDraggingChannelId(channelId);
    setDragOverChannelId(channelId);
  }, [savingOrder]);

  const handleDragMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (draggingChannelId === null) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el instanceof HTMLElement ? el.closest<HTMLElement>('[data-channel-id]') : null;
    if (!row) return;
    const idAttr = row.getAttribute('data-channel-id');
    if (!idAttr) return;
    const overId = Number.parseInt(idAttr, 10);
    if (Number.isNaN(overId)) return;
    setDragOverChannelId(overId);
  }, [draggingChannelId]);

  const handleDragEnd = useCallback(async (e?: React.PointerEvent<HTMLButtonElement>) => {
    if (e && dragPointerIdRef.current !== null && e.currentTarget.hasPointerCapture(dragPointerIdRef.current)) {
      e.currentTarget.releasePointerCapture(dragPointerIdRef.current);
    }
    dragPointerIdRef.current = null;
    if (draggingChannelId === null) return;
    const sourceId = draggingChannelId;
    const targetId = dragOverChannelId;
    setDraggingChannelId(null);
    setDragOverChannelId(null);
    if (targetId == null || sourceId === targetId) return;
    const reordered = reorderChannelsById(channels, sourceId, targetId);
    setChannels(reordered);
    await persistChannelOrder(reordered);
  }, [channels, draggingChannelId, dragOverChannelId, persistChannelOrder, reorderChannelsById]);

  // Fetch fresh suggestions each time AI tab is shown
  useEffect(() => {
    if (viewMode === 'ai') {
      getAISuggestions().then(r => setAiSuggestions(r.suggestions)).catch(() => {});
    }
  }, [viewMode]);

  const handleSuggestionClick = (prompt: string) => {
    setAiPrompt(prompt);
    // Auto-create immediately
    setAiCreating(true);
    setAiError('');
    setAiResult(null);
    createAIChannel(prompt)
      .then(async (result) => {
        setAiResult({
          channelName: result.channel.name,
          description: result.ai_description,
          itemCount: result.channel.item_ids.length,
        });
        setAiPrompt('');
        await loadData();
        // Refresh suggestions for next time
        getAISuggestions().then(r => setAiSuggestions(r.suggestions)).catch(() => {});
      })
      .catch((err: Error) => {
        setAiError(err.message);
      })
      .finally(() => {
        setAiCreating(false);
      });
  };

  // AI config handlers
  const handleSaveAIConfig = async () => {
    setAiConfigSaving(true);
    setAiError('');
    try {
      const update: { apiKey?: string; model?: string } = {};
      if (aiKeyInput) update.apiKey = aiKeyInput;
      if (aiModelInput !== aiConfig?.model) update.model = aiModelInput;

      const result = await updateAIConfig(update);
      setAiConfig(result);
      setAiKeyInput('');
      if (result.hasUserKey) {
        setAiConfigExpanded(false);
      }
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiConfigSaving(false);
    }
  };

  const handleClearAIKey = async () => {
    setAiConfigSaving(true);
    setAiError('');
    try {
      const result = await updateAIConfig({ apiKey: '' });
      setAiConfig(result);
      setAiConfigExpanded(true);
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiConfigSaving(false);
    }
  };

  const handleCreateAI = async () => {
    if (!aiPrompt.trim()) return;
    setAiCreating(true);
    setAiError('');
    setAiResult(null);
    try {
      const result = await createAIChannel(aiPrompt);
      setAiResult({
        channelName: result.channel.name,
        description: result.ai_description,
        itemCount: result.channel.item_ids.length,
      });
      setAiPrompt('');
      await loadData();
    } catch (err) {
      setAiError((err as Error).message);
    } finally {
      setAiCreating(false);
    }
  };

  const handleCreateManual = async () => {
    if (!channelName.trim()) return;
    setCreating(true);
    setError('');
    try {
      await createChannel(channelName, []);
      setChannelName('');
      setShowCreate(false);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const togglePreset = (presetId: string) => {
    setSelectedPresets(prev => {
      const newSet = new Set(prev);
      if (newSet.has(presetId)) {
        newSet.delete(presetId);
      } else {
        newSet.add(presetId);
        setPresetMultipliers(m => {
          const next = { ...m };
          if (next[presetId] == null) next[presetId] = 1;
          return next;
        });
      }
      return newSet;
    });
  };

  const setMultiplier = (presetId: string, value: number) => {
    setPresetMultipliers(prev => {
      const next = { ...prev, [presetId]: value };
      saveMultipliers(next);
      return next;
    });
  };

  const getMultiplier = (presetId: string): number =>
    presetMultipliers[presetId] ?? 1;

  const handleSeparateToggle = async () => {
    const newValue = !separateContentTypes;
    setSeparateContentTypes(newValue);
    try {
      await updateSettings({ separate_content_types: newValue });
    } catch {
      // Revert on failure
      setSeparateContentTypes(!newValue);
    }
  };

  const handleScheduleAutoUpdateToggle = async () => {
    const newValue = !scheduleAutoUpdateEnabled;
    setScheduleAutoUpdateEnabled(newValue);
    try {
      await updateSettings({ schedule_auto_update_enabled: newValue });
    } catch {
      setScheduleAutoUpdateEnabled(!newValue);
    }
  };

  const persistScheduleAutoUpdateHours = async (rawValue: number) => {
    const normalized = Math.max(1, Math.min(168, Math.floor(rawValue || 1)));
    const previous = scheduleAutoUpdateHours;
    setScheduleAutoUpdateHours(normalized);
    try {
      await updateSettings({ schedule_auto_update_hours: normalized });
    } catch {
      setScheduleAutoUpdateHours(previous);
    }
  };

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(categoryId)) {
        newSet.delete(categoryId);
      } else {
        newSet.add(categoryId);
      }
      return newSet;
    });
  };

  // Build preset list in UI order (by category, then preset) so same channel type is back-to-back
  const expandedPresetIds = useMemo(() => {
    const ids: string[] = [];
    if (!presetData) return ids;
    for (const category of presetData.categories) {
      const categoryPresets = presetData.presets.filter(p => p.category === category.id);
      for (const preset of categoryPresets) {
        if (!selectedPresets.has(preset.id)) continue;
        const count = getMultiplier(preset.id);
        for (let i = 0; i < count; i++) ids.push(preset.id);
      }
    }
    return ids;
  }, [presetData, selectedPresets, presetMultipliers]);

  const handleRegenerate = async () => {
    if (selectedPresets.size === 0) {
      setError('Please select at least one channel type');
      return;
    }
    setGenerating(true);
    setGenerationProgress({ step: 'starting', message: 'Starting channel generation...' });
    setError('');
    try {
      await generateChannels(expandedPresetIds);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
      setGenerationProgress(null);
    }
  };

  const presetsByCategory = useMemo(() => {
    if (!presetData) return new Map<string, ChannelPreset[]>();
    const map = new Map<string, ChannelPreset[]>();
    for (const category of presetData.categories) {
      const categoryPresets = presetData.presets.filter(p => p.category === category.id);
      if (categoryPresets.length > 0) {
        map.set(category.id, categoryPresets);
      }
    }
    return map;
  }, [presetData]);

  if (loading) return <div className="settings-loading">Loading...</div>;

  return (
    <div className="settings-section">
      {/* View Toggle */}
      <div className="settings-view-tabs">
        <button
          className={`settings-view-tab ${viewMode === 'presets' ? 'active' : ''}`}
          onClick={() => setViewMode('presets')}
        >
          CHANNEL TYPES
        </button>
        <button
          className={`settings-view-tab ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setViewMode('list')}
        >
          CHANNELS ({channels.length})
        </button>
        <button
          className={`settings-view-tab ${viewMode === 'ai' ? 'active' : ''}`}
          onClick={() => setViewMode('ai')}
        >
          AI CREATE
        </button>
      </div>

      {error && <div className="settings-error">{error}</div>}

      {viewMode === 'presets' && presetData && (
        <div className="settings-presets">
          {/* Regenerate Button - first so it sticks to top when scrolling */}
          <div className="settings-preset-actions">
            <button
              className="settings-btn-primary"
              onClick={handleRegenerate}
              disabled={generating || selectedPresets.size === 0}
            >
              {generating ? 'GENERATING...' : 'REGENERATE CHANNELS'}
            </button>
          </div>

          <p className="settings-field-hint">
            Select channel types to add to your lineup.
          </p>

          {/* Content Type Separation Toggle */}
          <div className="settings-separate-toggle">
            <div className="settings-toggle-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={separateContentTypes}
                  onChange={handleSeparateToggle}
                />
                <span className="settings-toggle-slider" />
              </label>
              <span className="settings-toggle-label">
                {separateContentTypes ? 'SEPARATE MOVIES & TV' : 'MIX MOVIES & TV'}
              </span>
            </div>
            <p className="settings-field-hint" style={{ marginTop: 4 }}>
              {separateContentTypes
                ? 'Each channel type creates separate movie and TV channels.'
                : 'Movies and TV shows are mixed together in each channel.'}
            </p>
          </div>

          {/* Schedule auto-update controls */}
          <div className="settings-separate-toggle">
            <div className="settings-toggle-row">
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={scheduleAutoUpdateEnabled}
                  onChange={handleScheduleAutoUpdateToggle}
                />
                <span className="settings-toggle-slider" />
              </label>
              <span className="settings-toggle-label">
                {scheduleAutoUpdateEnabled ? 'AUTO-UPDATE SCHEDULE ENABLED' : 'AUTO-UPDATE SCHEDULE DISABLED'}
              </span>
            </div>
            <div className="settings-field" style={{ marginTop: 8 }}>
              <label>Update every X hours</label>
              <input
                type="number"
                min={1}
                max={168}
                step={1}
                value={scheduleAutoUpdateHours}
                disabled={!scheduleAutoUpdateEnabled}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isNaN(n)) return;
                  setScheduleAutoUpdateHours(n);
                }}
                onBlur={() => {
                  void persistScheduleAutoUpdateHours(scheduleAutoUpdateHours);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void persistScheduleAutoUpdateHours(scheduleAutoUpdateHours);
                  }
                }}
              />
            </div>
            <p className="settings-field-hint" style={{ marginTop: 4 }}>
              Regenerates future schedule blocks automatically at this interval.
            </p>
          </div>

          {/* Progress indicator */}
          {generating && generationProgress && (
            <div className="settings-generation-progress">
              <div className="settings-progress-spinner" />
              <div className="settings-progress-text">
                <span className="settings-progress-message">{generationProgress.message}</span>
                {generationProgress.current && generationProgress.total && (
                  <span className="settings-progress-count">
                    ({generationProgress.current}/{generationProgress.total})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Preset Categories */}
          <div className="settings-preset-categories">
            {presetData.categories.map(category => {
              const categoryPresets = presetsByCategory.get(category.id) || [];
              if (categoryPresets.length === 0) return null;

              const isExpanded = expandedCategories.has(category.id);
              const selectedCount = categoryPresets.filter(p => selectedPresets.has(p.id)).length;

              return (
                <div key={category.id} className="settings-preset-category">
                  <button
                    className="settings-preset-category-header"
                    onClick={() => toggleCategory(category.id)}
                  >
                    <span className="settings-preset-category-icon">{category.icon}</span>
                    <span className="settings-preset-category-name">{category.name}</span>
                    {selectedCount > 0 && (
                      <span className="settings-preset-category-count">{selectedCount} selected</span>
                    )}
                    <span className={`settings-preset-category-arrow ${isExpanded ? 'expanded' : ''}`}>▼</span>
                  </button>

                  {isExpanded && (
                    <div className="settings-preset-list">
                      {categoryPresets.map(preset => {
                        const isSelected = selectedPresets.has(preset.id);
                        const isDynamic = preset.isDynamic;
                        const multiplier = getMultiplier(preset.id);

                        return (
                          <div
                            key={preset.id}
                            className={`settings-preset-item-wrap ${isSelected ? 'selected' : ''}`}
                          >
                            <button
                              className={`settings-preset-item ${isSelected ? 'selected' : ''} ${isDynamic ? 'dynamic' : ''}`}
                              onClick={() => togglePreset(preset.id)}
                            >
                              <span className="settings-preset-check">{isSelected ? '✓' : ''}</span>
                              <span className="settings-preset-icon">{preset.icon}</span>
                              <div className="settings-preset-info">
                                <span className="settings-preset-name">
                                  {preset.name}
                                </span>
                                <span className="settings-preset-desc">{preset.description}</span>
                              </div>
                            </button>
                            {isSelected && (
                              <div className="settings-preset-multiplier" onClick={e => e.stopPropagation()}>
                                {MULTIPLIER_OPTIONS.map(n => (
                                  <button
                                    key={n}
                                    type="button"
                                    className={`settings-multiplier-btn ${multiplier === n ? 'active' : ''}`}
                                    onClick={() => setMultiplier(preset.id, n)}
                                    title={`${n} channel${n > 1 ? 's' : ''}`}
                                  >
                                    {n}X
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewMode === 'list' && (
        <>
          <div className="settings-section-header">
            <h3>Active Channels</h3>
            <button className="settings-btn-primary" onClick={() => setShowCreate(!showCreate)}>
              {showCreate ? 'CANCEL' : '+ CUSTOM'}
            </button>
          </div>

          {showCreate && (
            <div className="settings-form">
              <div className="settings-field">
                <label>Channel Name</label>
                <input
                  type="text"
                  value={channelName}
                  onChange={e => setChannelName(e.target.value)}
                  placeholder="My Custom Channel"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreateManual();
                    }
                  }}
                />
              </div>
              <button
                className="settings-btn-primary"
                onClick={handleCreateManual}
                disabled={creating || !channelName.trim()}
              >
                {creating ? 'CREATING...' : 'CREATE CHANNEL'}
              </button>
            </div>
          )}

          <div className="settings-list">
            <p className="settings-field-hint" style={{ marginBottom: 4 }}>
              Drag the handle to reorder channels.
            </p>
            {channels.map(ch => (
              <div
                key={ch.id}
                data-channel-id={ch.id}
                className={`settings-list-item settings-list-item-draggable ${draggingChannelId === ch.id ? 'dragging' : ''} ${dragOverChannelId === ch.id && draggingChannelId !== null && draggingChannelId !== ch.id ? 'drag-over' : ''}`}
              >
                <div className="settings-list-info">
                  <span className="settings-list-name">
                    <span className="settings-channel-number">CH {ch.number}</span>
                    {ch.name}
                    <span className={`settings-badge settings-badge-${ch.type}`}>
                      {ch.type.toUpperCase()}
                    </span>
                    {ch.ai_prompt && (
                      <span className="settings-badge settings-badge-ai">AI</span>
                    )}
                  </span>
                  <span className="settings-list-detail">
                    {ch.item_ids.length} items
                    {ch.ai_prompt && ` · Prompt: "${ch.ai_prompt}"`}
                    {ch.current_program && ` · Now: ${ch.current_program.title}`}
                  </span>
                  <span className="settings-list-schedule-meta">
                    {ch.schedule_generated_at ? (
                      <>
                        Generated {formatRelativeTime(ch.schedule_generated_at)}
                        {ch.schedule_updated_at && ch.schedule_updated_at !== ch.schedule_generated_at && (
                          <> · Updated {formatRelativeTime(ch.schedule_updated_at)}</>
                        )}
                      </>
                    ) : (
                      'No schedule generated'
                    )}
                  </span>
                </div>
                <div className="settings-list-actions settings-list-actions-channel">
                  {ch.ai_prompt && (
                    <button
                      className="settings-btn-sm settings-btn-ai-refresh"
                      onClick={() => handleRefreshAI(ch.id)}
                      disabled={refreshingChannelId !== null || savingOrder || draggingChannelId !== null}
                      title={`Re-query AI with: "${ch.ai_prompt}"`}
                    >
                      {refreshingChannelId === ch.id ? 'UPDATING...' : 'REFRESH'}
                    </button>
                  )}
                  <button
                    className="settings-btn-sm settings-btn-reorder settings-btn-drag-handle"
                    onPointerDown={(e) => handleDragStart(ch.id, e)}
                    onPointerMove={handleDragMove}
                    onPointerUp={(e) => { void handleDragEnd(e); }}
                    onPointerCancel={(e) => { void handleDragEnd(e); }}
                    disabled={savingOrder}
                    title="Drag to reorder channel"
                  >
                    DRAG
                  </button>
                  <button
                    className="settings-btn-sm settings-btn-danger"
                    onClick={() => handleDelete(ch.id)}
                    disabled={savingOrder || draggingChannelId !== null}
                  >
                    DELETE
                  </button>
                </div>
              </div>
            ))}
            {channels.length === 0 && (
              <div className="settings-empty">
                No channels yet. Go to Channel Types to generate channels.
              </div>
            )}
          </div>
        </>
      )}

      {viewMode === 'ai' && (
        <div className="settings-ai">
          {/* OpenRouter Configuration */}
          <div className="settings-ai-config">
            <button
              className="settings-ai-config-header"
              onClick={() => setAiConfigExpanded(!aiConfigExpanded)}
            >
              <span className="settings-ai-config-title">OpenRouter Configuration</span>
              <div className="settings-ai-config-status">
                {aiConfig?.hasKey ? (
                  <span className="settings-badge settings-badge-ai-active">CONNECTED</span>
                ) : (
                  <span className="settings-badge settings-badge-ai-inactive">NOT CONFIGURED</span>
                )}
                <span className={`settings-preset-category-arrow ${aiConfigExpanded ? 'expanded' : ''}`}>▼</span>
              </div>
            </button>

            {aiConfigExpanded && (
              <div className="settings-ai-config-body">
                {aiConfig?.hasEnvKey && !aiConfig?.hasUserKey && (
                  <p className="settings-field-hint">
                    Using API key from server environment. You can override it below.
                  </p>
                )}

                <div className="settings-field">
                  <label>API Key</label>
                  {aiConfig?.hasUserKey ? (
                    <div className="settings-ai-key-configured">
                      <span className="settings-ai-key-mask">sk-or-...configured</span>
                      <button
                        className="settings-btn-sm settings-btn-danger"
                        onClick={handleClearAIKey}
                        disabled={aiConfigSaving}
                      >
                        CLEAR
                      </button>
                    </div>
                  ) : (
                    <input
                      type="password"
                      value={aiKeyInput}
                      onChange={e => setAiKeyInput(e.target.value)}
                      placeholder="sk-or-..."
                      autoComplete="off"
                    />
                  )}
                  <span className="settings-field-hint">
                    Get your API key from openrouter.ai
                  </span>
                </div>

                <div className="settings-field">
                  <label>Model</label>
                  <input
                    type="text"
                    value={aiModelInput}
                    onChange={e => setAiModelInput(e.target.value)}
                    placeholder={aiConfig?.defaultModel || 'google/gemini-3-flash-preview'}
                  />
                  <span className="settings-field-hint">
                    OpenRouter model ID (e.g. google/gemini-3-flash-preview, anthropic/claude-sonnet-4)
                  </span>
                </div>

                <button
                  className="settings-btn-primary"
                  onClick={handleSaveAIConfig}
                  disabled={aiConfigSaving || (!aiKeyInput && aiModelInput === aiConfig?.model)}
                >
                  {aiConfigSaving ? 'SAVING...' : 'SAVE CONFIGURATION'}
                </button>
              </div>
            )}
          </div>

          {/* AI Channel Creation */}
          <div className="settings-ai-create">
            <h3>Create a Channel with AI</h3>
            <p className="settings-field-hint">
              Describe the kind of channel you want and AI will curate content from your library.
            </p>

            {!aiConfig?.hasKey && !aiConfig?.hasEnvKey ? (
              <div className="settings-ai-unconfigured">
                <p>Configure your OpenRouter API key above to start creating AI channels.</p>
              </div>
            ) : (
              <>
                {/* Suggestion chips */}
                {aiSuggestions.length > 0 && !aiCreating && !aiResult && (
                  <div className="settings-ai-suggestions">
                    <span className="settings-ai-suggestions-label">Try:</span>
                    {aiSuggestions.map((s, i) => (
                      <button
                        key={i}
                        className="settings-ai-suggestion-chip"
                        onClick={() => handleSuggestionClick(s)}
                        disabled={aiCreating}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}

                {/* Success result */}
                {aiResult && (
                  <div className="settings-ai-result">
                    <div className="settings-ai-result-header">Channel Created</div>
                    <div className="settings-ai-result-name">{aiResult.channelName}</div>
                    <div className="settings-ai-result-desc">{aiResult.description}</div>
                    <div className="settings-ai-result-meta">{aiResult.itemCount} items added to channel</div>
                    <button
                      className="settings-btn-accent settings-btn-sm"
                      onClick={() => {
                        setAiResult(null);
                        setViewMode('list');
                      }}
                    >
                      VIEW IN CHANNELS
                    </button>
                  </div>
                )}

                {/* Prompt input */}
                <div className="settings-ai-prompt-area">
                  <textarea
                    className="settings-ai-prompt"
                    value={aiPrompt}
                    onChange={e => setAiPrompt(e.target.value)}
                    placeholder={"Describe your channel...\n\ne.g. \"80s action movies\" or \"cozy rainy day vibes\" or \"sci-fi TV marathon\""}
                    rows={4}
                    disabled={aiCreating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void handleCreateAI();
                      }
                    }}
                  />

                  <button
                    className="settings-btn-primary settings-ai-create-btn"
                    onClick={handleCreateAI}
                    disabled={aiCreating || !aiPrompt.trim()}
                  >
                    {aiCreating ? (
                      <span className="settings-ai-creating">
                        <span className="settings-progress-spinner" />
                        CURATING YOUR CHANNEL...
                      </span>
                    ) : (
                      'CREATE CHANNEL'
                    )}
                  </button>

                  {aiError && <div className="settings-error">{aiError}</div>}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
