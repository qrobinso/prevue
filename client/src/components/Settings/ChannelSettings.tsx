import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { 
  getChannels, 
  deleteChannel, 
  updateChannel,
  createChannel, 
  createAIChannel, 
  getAIStatus, 
  getChannelPresets,
  getSelectedPresets,
  generateChannels,
  getSettings,
  updateSettings,
  type ChannelWithProgram,
  type ChannelPresetData,
  type ChannelPreset,
} from '../../services/api';
import { wsClient } from '../../services/websocket';

type ViewMode = 'list' | 'presets';

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

export default function ChannelSettings() {
  const [channels, setChannels] = useState<ChannelWithProgram[]>([]);
  const [presetData, setPresetData] = useState<ChannelPresetData | null>(null);
  const [selectedPresets, setSelectedPresets] = useState<Set<string>>(new Set());
  const [presetMultipliers, setPresetMultipliers] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<'ai' | 'manual'>('ai');
  const [aiPrompt, setAiPrompt] = useState('');
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
      const [channelsData, aiStatus, presetsData, savedPresets, settingsData] = await Promise.all([
        getChannels(),
        getAIStatus().catch(() => ({ available: false })),
        getChannelPresets(),
        getSelectedPresets().catch(() => []),
        getSettings().catch(() => ({})),
      ]);
      setChannels(channelsData);
      setAiAvailable(aiStatus.available);
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

  const handleCreateAI = async () => {
    if (!aiPrompt.trim()) return;
    setCreating(true);
    setError('');
    try {
      await createAIChannel(aiPrompt);
      setAiPrompt('');
      setShowCreate(false);
      await loadData();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
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

  // Build preset list in UI order (by category, then preset) so same channel type is back-to-back: Action, Action 2, Action 3, etc.
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
          CURRENT CHANNELS ({channels.length})
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
              <div className="settings-create-tabs">
                {aiAvailable && (
                  <button
                    className={`settings-create-tab ${createMode === 'ai' ? 'active' : ''}`}
                    onClick={() => setCreateMode('ai')}
                  >
                    AI CREATE
                  </button>
                )}
                <button
                  className={`settings-create-tab ${createMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setCreateMode('manual')}
                >
                  MANUAL
                </button>
              </div>

              {createMode === 'ai' && aiAvailable ? (
                <>
                  <div className="settings-field">
                    <label>Describe your channel</label>
                    <textarea
                      value={aiPrompt}
                      onChange={e => setAiPrompt(e.target.value)}
                      placeholder='e.g., "Create a 90s nostalgia channel" or "Horror movies marathon"'
                      rows={3}
                    />
                  </div>
                  <button
                    className="settings-btn-primary"
                    onClick={handleCreateAI}
                    disabled={creating || !aiPrompt.trim()}
                  >
                    {creating ? 'CREATING...' : 'CREATE WITH AI'}
                  </button>
                </>
              ) : (
                <>
                  <div className="settings-field">
                    <label>Channel Name</label>
                    <input
                      type="text"
                      value={channelName}
                      onChange={e => setChannelName(e.target.value)}
                      placeholder="My Custom Channel"
                    />
                  </div>
                  <button
                    className="settings-btn-primary"
                    onClick={handleCreateManual}
                    disabled={creating || !channelName.trim()}
                  >
                    {creating ? 'CREATING...' : 'CREATE CHANNEL'}
                  </button>
                </>
              )}
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
                  </span>
                  <span className="settings-list-detail">
                    {ch.item_ids.length} items
                    {ch.current_program && ` · Now: ${ch.current_program.title}`}
                  </span>
                </div>
                <div className="settings-list-actions settings-list-actions-channel">
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
    </div>
  );
}
