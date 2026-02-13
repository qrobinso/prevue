import type Database from 'better-sqlite3';
import * as queries from '../db/queries.js';

export class MetricsService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Check whether metrics collection is enabled in settings */
  isEnabled(): boolean {
    const val = queries.getSetting(this.db, 'metrics_enabled');
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val === 'true';
    return true; // default on
  }

  /** Register / update a client's last-seen time */
  touchClient(clientId: string, userAgent?: string): void {
    queries.upsertClient(this.db, clientId, userAgent);
  }

  /**
   * Start a new watch session.
   * Automatically ends any open session for the same client first.
   */
  startSession(data: {
    client_id: string;
    channel_id?: number;
    channel_name?: string;
    item_id?: string;
    title?: string;
    series_name?: string;
    content_type?: string;
    user_agent?: string;
  }): queries.WatchSession {
    // Close any existing open session for this client
    const open = queries.getActiveSessionForClient(this.db, data.client_id);
    if (open) {
      queries.endWatchSession(this.db, open.id);
    }

    this.touchClient(data.client_id, data.user_agent);

    const session = queries.createWatchSession(this.db, data);

    queries.insertWatchEvent(this.db, {
      client_id: data.client_id,
      event_type: 'playback_start',
      channel_id: data.channel_id,
      channel_name: data.channel_name,
      item_id: data.item_id,
      title: data.title,
    });

    return session;
  }

  /** End the active session for a client */
  stopSession(clientId: string): void {
    const open = queries.getActiveSessionForClient(this.db, clientId);
    if (open) {
      queries.endWatchSession(this.db, open.id);

      queries.insertWatchEvent(this.db, {
        client_id: clientId,
        event_type: 'playback_stop',
        channel_id: open.channel_id ?? undefined,
        channel_name: open.channel_name ?? undefined,
        item_id: open.item_id ?? undefined,
        title: open.title ?? undefined,
      });
    }
  }

  /** Record a channel-switch event */
  recordChannelSwitch(data: {
    client_id: string;
    from_channel_id?: number;
    from_channel_name?: string;
    to_channel_id?: number;
    to_channel_name?: string;
  }): void {
    this.touchClient(data.client_id);

    queries.insertWatchEvent(this.db, {
      client_id: data.client_id,
      event_type: 'channel_switch',
      channel_id: data.to_channel_id,
      channel_name: data.to_channel_name,
      metadata: {
        from_channel_id: data.from_channel_id,
        from_channel_name: data.from_channel_name,
      },
    });
  }

  /** Get dashboard data for a given time range */
  getDashboard(since: string) {
    const summary = queries.getMetricsSummary(this.db, since);
    const topChannels = queries.getTopChannels(this.db, since, 10);
    const topShows = queries.getTopShows(this.db, since, 10);
    const topSeries = queries.getTopSeries(this.db, since, 10);
    const topClients = queries.getTopClients(this.db, since, 10);
    const hourlyActivity = queries.getHourlyActivity(this.db, since);
    const recentSessions = queries.getRecentSessions(this.db, 20);

    return {
      enabled: true,
      summary,
      topChannels,
      topShows,
      topSeries,
      topClients,
      hourlyActivity,
      recentSessions,
    };
  }

  /** Clear all metrics data */
  clearData(): void {
    queries.clearMetricsData(this.db);
  }
}
