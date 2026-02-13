import { Router } from 'express';
import type { Request, Response } from 'express';
import type { MetricsService } from '../services/MetricsService.js';

export const metricsRoutes = Router();

function getService(req: Request): MetricsService {
  return req.app.locals.metricsService as MetricsService;
}

// ─── Ingestion endpoints ─────────────────────────────

// POST /api/metrics/start - Start a watch session
metricsRoutes.post('/start', (req: Request, res: Response) => {
  try {
    const svc = getService(req);
    if (!svc.isEnabled()) {
      res.json({ success: true, enabled: false });
      return;
    }

    const { client_id, channel_id, channel_name, item_id, title, series_name, content_type } = req.body;
    if (!client_id) {
      res.status(400).json({ error: 'client_id is required' });
      return;
    }

    const userAgent = req.headers['user-agent'];
    const session = svc.startSession({
      client_id,
      channel_id,
      channel_name,
      item_id,
      title,
      series_name,
      content_type,
      user_agent: userAgent,
    });

    res.json({ success: true, session_id: session.id });
  } catch (err) {
    console.error('[Metrics] Error starting session:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/metrics/stop - Stop the active watch session
metricsRoutes.post('/stop', (req: Request, res: Response) => {
  try {
    const svc = getService(req);
    if (!svc.isEnabled()) {
      res.json({ success: true, enabled: false });
      return;
    }

    const { client_id } = req.body;
    if (!client_id) {
      res.status(400).json({ error: 'client_id is required' });
      return;
    }

    svc.stopSession(client_id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Metrics] Error stopping session:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/metrics/channel-switch - Record a channel switch event
metricsRoutes.post('/channel-switch', (req: Request, res: Response) => {
  try {
    const svc = getService(req);
    if (!svc.isEnabled()) {
      res.json({ success: true, enabled: false });
      return;
    }

    const { client_id, from_channel_id, from_channel_name, to_channel_id, to_channel_name } = req.body;
    if (!client_id) {
      res.status(400).json({ error: 'client_id is required' });
      return;
    }

    svc.recordChannelSwitch({
      client_id,
      from_channel_id,
      from_channel_name,
      to_channel_id,
      to_channel_name,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[Metrics] Error recording channel switch:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Read endpoints ──────────────────────────────────

// GET /api/metrics/dashboard?range=24h|7d|30d|all
metricsRoutes.get('/dashboard', (req: Request, res: Response) => {
  try {
    const svc = getService(req);
    if (!svc.isEnabled()) {
      res.json({ enabled: false });
      return;
    }

    const range = (req.query.range as string) || '7d';
    const since = rangeToISO(range);
    const data = svc.getDashboard(since);

    res.json(data);
  } catch (err) {
    console.error('[Metrics] Error fetching dashboard:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/metrics/data - Clear all metrics data
metricsRoutes.delete('/data', (_req: Request, res: Response) => {
  try {
    const svc = getService(_req);
    svc.clearData();
    res.json({ success: true });
  } catch (err) {
    console.error('[Metrics] Error clearing data:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── Helpers ─────────────────────────────────────────

function rangeToISO(range: string): string {
  const now = new Date();
  switch (range) {
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'all':
      return '1970-01-01T00:00:00.000Z';
    default:
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
}
