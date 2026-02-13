import { useState, useEffect, useCallback } from 'react';
import {
  getSettings,
  updateSettings,
  getMetricsDashboard,
  clearMetricsData,
  type MetricsDashboard,
} from '../../services/api';
import './Settings.css';

type TimeRange = '24h' | '7d' | '30d' | 'all';

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatDurationShort(totalSeconds: number): string {
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown';
  // Try to extract browser name
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/') && !ua.includes('Edg/')) return 'Chrome';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
  if (ua.includes('Mobile')) return 'Mobile Browser';
  return 'Browser';
}

export default function MetricsSettings() {
  const [metricsEnabled, setMetricsEnabled] = useState(true);
  const [range, setRange] = useState<TimeRange>('7d');
  const [dashboard, setDashboard] = useState<MetricsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Load metrics enabled setting
  useEffect(() => {
    getSettings()
      .then((s) => {
        if (typeof s['metrics_enabled'] === 'boolean') {
          setMetricsEnabled(s['metrics_enabled'] as boolean);
        }
      })
      .catch(() => {});
  }, []);

  const loadDashboard = useCallback(async (r: TimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getMetricsDashboard(r);
      setDashboard(data);
      if (!data.enabled) {
        setMetricsEnabled(false);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard(range);
  }, [range, loadDashboard]);

  const handleToggleMetrics = async () => {
    const newValue = !metricsEnabled;
    setMetricsEnabled(newValue);
    try {
      await updateSettings({ metrics_enabled: newValue });
      if (newValue) {
        loadDashboard(range);
      }
    } catch {
      // Revert on failure
      setMetricsEnabled(!newValue);
    }
  };

  const handleClearData = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setClearing(true);
    try {
      await clearMetricsData();
      setConfirmClear(false);
      loadDashboard(range);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const summary = dashboard?.summary;
  const maxChannelSeconds = dashboard?.topChannels?.[0]?.total_seconds || 1;
  const maxSeriesSeconds = dashboard?.topSeries?.[0]?.total_seconds || 1;
  const maxShowSeconds = dashboard?.topShows?.[0]?.total_seconds || 1;
  const maxHourSessions = Math.max(...(dashboard?.hourlyActivity?.map(h => h.session_count) || [1]));

  return (
    <div className="settings-section">
      <h3>METRICS</h3>

      <div className="settings-subsection">
        <h4>TRACKING</h4>
        <div className="settings-toggle-row">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={metricsEnabled}
              onChange={handleToggleMetrics}
            />
            <span className="settings-toggle-slider" />
          </label>
          <span className="settings-toggle-label">
            Enable metrics tracking
          </span>
        </div>
        <p className="settings-field-hint">
          {metricsEnabled
            ? 'Prevue is recording what channels and shows are watched, when, and from which device.'
            : 'Metrics tracking is disabled. No new watch data is being collected. Previously collected data is still visible below.'}
        </p>
      </div>

      {!metricsEnabled && (
        <div className="metrics-disabled-banner">
          Metrics collection is off. Enable it above to start tracking watch activity.
        </div>
      )}

      <div className="settings-subsection">
        <h4>TIME RANGE</h4>
        <div className="metrics-range-options">
          {(['24h', '7d', '30d', 'all'] as TimeRange[]).map((r) => (
            <button
              key={r}
              className={`metrics-range-btn ${range === r ? 'active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'all' ? 'All' : r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="settings-loading">Loading metrics...</div>
      )}

      {error && (
        <div className="settings-error">{error}</div>
      )}

      {!loading && summary && (
        <>
          {/* Summary cards */}
          <div className="settings-subsection">
            <h4>SUMMARY</h4>
            <div className="metrics-summary-cards">
              <div className="metrics-card">
                <div className="metrics-card-value">{formatDuration(summary.total_watch_seconds)}</div>
                <div className="metrics-card-label">Watch Time</div>
              </div>
              <div className="metrics-card">
                <div className="metrics-card-value">{summary.total_sessions}</div>
                <div className="metrics-card-label">Sessions</div>
              </div>
              <div className="metrics-card">
                <div className="metrics-card-value">{summary.active_clients}</div>
                <div className="metrics-card-label">Clients</div>
              </div>
            </div>
          </div>

          {/* Top channels */}
          {dashboard.topChannels && dashboard.topChannels.length > 0 && (
            <div className="settings-subsection">
              <h4>TOP CHANNELS</h4>
              <div className="metrics-bar-list">
                {dashboard.topChannels.map((ch) => (
                  <div key={ch.channel_id} className="metrics-bar-item">
                    <div className="metrics-bar-label">
                      <span className="metrics-bar-name">{ch.channel_name || `Ch ${ch.channel_id}`}</span>
                      <span className="metrics-bar-stat">{formatDurationShort(ch.total_seconds)}</span>
                    </div>
                    <div className="metrics-bar-track">
                      <div
                        className="metrics-bar-fill"
                        style={{ width: `${Math.max(2, (ch.total_seconds / maxChannelSeconds) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top series (aggregated by show) */}
          {dashboard.topSeries && dashboard.topSeries.length > 0 && (
            <div className="settings-subsection">
              <h4>TOP SERIES</h4>
              <div className="metrics-bar-list">
                {dashboard.topSeries.map((series) => (
                  <div key={series.series_name} className="metrics-bar-item">
                    <div className="metrics-bar-label">
                      <span className="metrics-bar-name">{series.series_name}</span>
                      <span className="metrics-bar-stat">
                        {formatDurationShort(series.total_seconds)}
                        {series.episode_count > 1 && ` · ${series.episode_count} eps`}
                      </span>
                    </div>
                    <div className="metrics-bar-track">
                      <div
                        className="metrics-bar-fill metrics-bar-fill-alt"
                        style={{ width: `${Math.max(2, (series.total_seconds / maxSeriesSeconds) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top individual items (episodes/movies) */}
          {dashboard.topShows && dashboard.topShows.length > 0 && (
            <div className="settings-subsection">
              <h4>TOP ITEMS</h4>
              <div className="metrics-bar-list">
                {dashboard.topShows.map((show) => (
                  <div key={show.item_id} className="metrics-bar-item">
                    <div className="metrics-bar-label">
                      <span className="metrics-bar-name">{show.title}</span>
                      <span className="metrics-bar-stat">{formatDurationShort(show.total_seconds)}</span>
                    </div>
                    <div className="metrics-bar-track">
                      <div
                        className="metrics-bar-fill metrics-bar-fill-series"
                        style={{ width: `${Math.max(2, (show.total_seconds / maxShowSeconds) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top clients */}
          {dashboard.topClients && dashboard.topClients.length > 0 && (
            <div className="settings-subsection">
              <h4>CLIENTS</h4>
              <div className="metrics-client-list">
                {dashboard.topClients.map((client) => (
                  <div key={client.client_id} className="metrics-client-item">
                    <div className="metrics-client-browser">{parseUserAgent(client.user_agent)}</div>
                    <div className="metrics-client-detail">
                      {formatDurationShort(client.total_seconds)} &middot; {client.session_count} session{client.session_count !== 1 ? 's' : ''}
                      {client.last_seen && (
                        <span className="metrics-client-lastseen"> &middot; Last seen {formatTimestamp(client.last_seen)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hourly activity */}
          {dashboard.hourlyActivity && dashboard.hourlyActivity.length > 0 && (
            <div className="settings-subsection">
              <h4>ACTIVITY BY HOUR</h4>
              <div className="metrics-hourly-chart">
                {Array.from({ length: 24 }, (_, h) => {
                  const entry = dashboard.hourlyActivity!.find((e) => e.hour === h);
                  const count = entry?.session_count ?? 0;
                  const pct = maxHourSessions > 0 ? (count / maxHourSessions) * 100 : 0;
                  return (
                    <div
                      key={h}
                      className="metrics-hourly-bar"
                      title={`${h}:00 - ${count} session${count !== 1 ? 's' : ''}`}
                    >
                      <div
                        className="metrics-hourly-bar-fill"
                        style={{ height: `${Math.max(pct > 0 ? 4 : 0, pct)}%` }}
                      />
                      {h % 6 === 0 && (
                        <span className="metrics-hourly-label">{h === 0 ? '12a' : h === 6 ? '6a' : h === 12 ? '12p' : '6p'}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent sessions */}
          {dashboard.recentSessions && dashboard.recentSessions.length > 0 && (
            <div className="settings-subsection">
              <h4>RECENT SESSIONS</h4>
              <div className="metrics-sessions-list">
                {dashboard.recentSessions.map((s) => (
                  <div key={s.id} className="metrics-session-item">
                    <div className="metrics-session-title">{s.title || 'Unknown'}</div>
                    <div className="metrics-session-detail">
                      {s.channel_name && <span>{s.channel_name}</span>}
                      {s.channel_name && ' · '}
                      <span>{formatDurationShort(s.duration_seconds)}</span>
                      {' · '}
                      <span>{formatTimestamp(s.started_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No data state */}
          {summary.total_sessions === 0 && (
            <div className="settings-subsection">
              <p className="settings-empty">
                No watch data for this time range. Start watching some channels to see metrics here.
              </p>
            </div>
          )}
        </>
      )}

      {/* Clear data */}
      <div className="settings-subsection settings-danger-zone">
        <h4>DATA MANAGEMENT</h4>
        <p className="settings-field-hint">
          Clear all recorded watch history and metrics data. This cannot be undone.
        </p>
        <button
          className={`settings-btn-sm settings-btn-danger ${confirmClear ? 'settings-btn-danger-confirm' : ''}`}
          onClick={handleClearData}
          disabled={clearing}
        >
          {clearing ? 'CLEARING...' : confirmClear ? 'CLICK AGAIN TO CONFIRM' : 'CLEAR ALL METRICS DATA'}
        </button>
        {confirmClear && !clearing && (
          <button
            className="settings-btn-sm"
            onClick={() => setConfirmClear(false)}
            style={{ marginLeft: 8 }}
          >
            CANCEL
          </button>
        )}
      </div>
    </div>
  );
}
