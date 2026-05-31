import type Database from 'better-sqlite3';
import * as queries from '../db/queries.js';

export class MetricsService {
  private db: Database.Database;
  /** Ref-count of live WebSocket connections per client_id */
  private onlineClients = new Map<string, number>();

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

  /** Register / update a client (app open or WebSocket connect) */
  registerClient(data: {
    client_id: string;
    user_agent?: string;
    display_name?: string;
    platform?: string;
    via_websocket?: boolean;
  }): void {
    if (!this.isEnabled()) return;

    queries.upsertClient(this.db, data.client_id, {
      userAgent: data.user_agent,
      displayName: data.display_name,
      platform: data.platform,
    });

    if (data.via_websocket) {
      this.setClientOnline(data.client_id, true);
    }
  }

  setClientOnline(clientId: string, online: boolean): void {
    const prev = this.onlineClients.get(clientId) ?? 0;
    const next = online ? prev + 1 : Math.max(0, prev - 1);
    if (next === 0) {
      this.onlineClients.delete(clientId);
    } else {
      this.onlineClients.set(clientId, next);
    }
  }

  isClientOnline(clientId: string): boolean {
    return (this.onlineClients.get(clientId) ?? 0) > 0;
  }

  /** Register / update a client's last-seen time */
  touchClient(
    clientId: string,
    options?: { userAgent?: string; displayName?: string; platform?: string }
  ): void {
    queries.upsertClient(this.db, clientId, options);
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
    display_name?: string;
    platform?: string;
  }): queries.WatchSession {
    // Close any existing open session for this client
    const open = queries.getActiveSessionForClient(this.db, data.client_id);
    if (open) {
      queries.endWatchSession(this.db, open.id);
    }

    this.touchClient(data.client_id, {
      userAgent: data.user_agent,
      displayName: data.display_name,
      platform: data.platform,
    });

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
    user_agent?: string;
    display_name?: string;
    platform?: string;
  }): void {
    this.touchClient(data.client_id, {
      userAgent: data.user_agent,
      displayName: data.display_name,
      platform: data.platform,
    });

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
    const topClients = queries.getTopClients(this.db, since, 50).map((client) => ({
      ...client,
      is_online: this.isClientOnline(client.client_id),
    }));
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
    this.onlineClients.clear();
  }
}
