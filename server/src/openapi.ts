/**
 * OpenAPI 3.0 specification for the Prevue API.
 * Served at /api/docs via swagger-ui-express.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Prevue API',
    version: '1.0.0',
    description:
      'Prevue is a retro cable-TV guide and player that turns a Jellyfin media server into a scheduled, channel-based viewing experience. This API powers channel management, schedule generation, HLS streaming, IPTV, and real-time updates.',
  },
  servers: [{ url: '/api', description: 'Prevue API' }],
  tags: [
    { name: 'Auth & Health', description: 'Authentication status and health checks' },
    { name: 'Channels', description: 'Channel CRUD, AI generation, presets, and library search' },
    { name: 'Schedule', description: 'Program schedule queries and regeneration' },
    { name: 'Playback', description: 'Stream info for the current program on a channel' },
    { name: 'Stream', description: 'HLS proxy, playback sessions, progress reporting, and image proxy' },
    { name: 'Settings', description: 'User and system settings' },
    { name: 'Servers', description: 'Jellyfin server discovery, configuration, and management' },
    { name: 'Metrics', description: 'Watch session analytics and dashboard' },
    { name: 'IPTV', description: 'M3U playlist, XMLTV EPG, and live channel streams for external players' },
    { name: 'Assets', description: 'Static assets (background music)' },
  ],
  components: {
    securitySchemes: {
      ApiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      ApiKeyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
    },
    schemas: {
      Channel: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          number: { type: 'integer' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['auto', 'custom', 'preset'] },
          genre: { type: 'string', nullable: true },
          preset_id: { type: 'string', nullable: true },
          item_ids: { type: 'array', items: { type: 'string' } },
          ai_prompt: { type: 'string', nullable: true },
          sort_order: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ChannelWithProgram: {
        allOf: [
          { $ref: '#/components/schemas/Channel' },
          {
            type: 'object',
            properties: {
              current_program: { $ref: '#/components/schemas/ScheduleProgram' },
              next_program: { $ref: '#/components/schemas/ScheduleProgram' },
              schedule_generated_at: { type: 'string', format: 'date-time', nullable: true },
              schedule_updated_at: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        ],
      },
      ScheduleProgram: {
        type: 'object',
        properties: {
          jellyfin_item_id: { type: 'string' },
          title: { type: 'string' },
          subtitle: { type: 'string', nullable: true },
          start_time: { type: 'string', format: 'date-time' },
          end_time: { type: 'string', format: 'date-time' },
          duration_ms: { type: 'integer' },
          type: { type: 'string', enum: ['program', 'interstitial'] },
          content_type: { type: 'string', enum: ['movie', 'episode'], nullable: true },
          backdrop_url: { type: 'string', nullable: true },
          guide_url: { type: 'string', nullable: true },
          thumbnail_url: { type: 'string', nullable: true },
          banner_url: { type: 'string', nullable: true },
          year: { type: 'integer', nullable: true },
          rating: { type: 'string', nullable: true },
          resolution: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
        },
      },
      ScheduleBlock: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          channel_id: { type: 'integer' },
          block_start: { type: 'string', format: 'date-time' },
          block_end: { type: 'string', format: 'date-time' },
          programs: { type: 'array', items: { $ref: '#/components/schemas/ScheduleProgram' } },
          seed: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AudioTrackInfo: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          language: { type: 'string', example: 'eng' },
          name: { type: 'string', example: 'English - AAC Stereo' },
        },
      },
      SubtitleTrackInfo: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          language: { type: 'string' },
          name: { type: 'string' },
        },
      },
      PlaybackInfo: {
        type: 'object',
        properties: {
          stream_url: { type: 'string', nullable: true, description: 'HLS master playlist URL. Null for interstitials.' },
          seek_position_ms: { type: 'integer', description: 'Position in media file (ms)' },
          seek_position_seconds: { type: 'number' },
          program: { $ref: '#/components/schemas/ScheduleProgram' },
          next_program: { $ref: '#/components/schemas/ScheduleProgram' },
          channel: { $ref: '#/components/schemas/Channel' },
          is_interstitial: { type: 'boolean' },
          audio_tracks: { type: 'array', items: { $ref: '#/components/schemas/AudioTrackInfo' } },
          audio_stream_index: { type: 'integer', nullable: true },
          subtitle_tracks: { type: 'array', items: { $ref: '#/components/schemas/SubtitleTrackInfo' } },
          subtitle_index: { type: 'integer', nullable: true },
          outro_start_ms: { type: 'integer', nullable: true, description: 'Credits start position (ms) from Jellyfin MediaSegments API' },
        },
      },
      ServerInfo: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          url: { type: 'string' },
          username: { type: 'string' },
          is_active: { type: 'boolean' },
          is_authenticated: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AIConfig: {
        type: 'object',
        properties: {
          hasKey: { type: 'boolean' },
          hasUserKey: { type: 'boolean' },
          hasEnvKey: { type: 'boolean' },
          model: { type: 'string' },
          defaultModel: { type: 'string' },
          available: { type: 'boolean' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string' } },
      },
    },
  },
  security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
  paths: {
    // ── Auth & Health ──────────────────────────────────
    '/auth/status': {
      get: {
        tags: ['Auth & Health'],
        summary: 'Check auth requirement',
        description: 'Returns whether API key authentication is enabled.',
        security: [],
        responses: {
          200: { description: 'Auth status', content: { 'application/json': { schema: { type: 'object', properties: { required: { type: 'boolean' } } } } } },
        },
      },
    },
    '/health': {
      get: {
        tags: ['Auth & Health'],
        summary: 'Health check',
        security: [],
        responses: {
          200: { description: 'Healthy', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, timestamp: { type: 'string', format: 'date-time' } } } } } },
        },
      },
    },

    // ── Channels ───────────────────────────────────────
    '/channels': {
      get: {
        tags: ['Channels'],
        summary: 'List all channels',
        description: 'Returns all channels with their currently airing and next program.',
        responses: { 200: { description: 'Channel list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ChannelWithProgram' } } } } } },
      },
      post: {
        tags: ['Channels'],
        summary: 'Create custom channel',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name', 'item_ids'], properties: { name: { type: 'string' }, item_ids: { type: 'array', items: { type: 'string' } } } } } },
        },
        responses: { 200: { description: 'Created channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } } },
      },
    },
    '/channels/{id}': {
      put: {
        tags: ['Channels'],
        summary: 'Update channel',
        description: 'Update name, items, or sort order. Regenerates schedule if items change.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, item_ids: { type: 'array', items: { type: 'string' } }, sort_order: { type: 'integer' } } } } },
        },
        responses: { 200: { description: 'Updated channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } } },
      },
      delete: {
        tags: ['Channels'],
        summary: 'Delete channel',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },
    '/channels/{id}/ai-refresh': {
      put: {
        tags: ['Channels'],
        summary: 'Refresh AI channel items',
        description: 'Re-run the AI prompt on an AI-generated channel to pick up new library items.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Refreshed channel', content: { 'application/json': { schema: { type: 'object', properties: { channel: { $ref: '#/components/schemas/Channel' }, ai_description: { type: 'string' } } } } } } },
      },
    },
    '/channels/ai': {
      post: {
        tags: ['Channels'],
        summary: 'Create channel via AI',
        description: 'Generate a channel from a natural language prompt. Requires OpenRouter API key.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', example: '90s action movies' } } } } },
        },
        responses: { 200: { description: 'AI-generated channel', content: { 'application/json': { schema: { type: 'object', properties: { channel: { $ref: '#/components/schemas/Channel' }, ai_description: { type: 'string' } } } } } } },
      },
    },
    '/channels/ai/status': {
      get: {
        tags: ['Channels'],
        summary: 'Check AI availability',
        responses: { 200: { description: 'AI status', content: { 'application/json': { schema: { type: 'object', properties: { available: { type: 'boolean' } } } } } } },
      },
    },
    '/channels/ai/config': {
      get: {
        tags: ['Channels'],
        summary: 'Get AI configuration',
        responses: { 200: { description: 'AI config', content: { 'application/json': { schema: { $ref: '#/components/schemas/AIConfig' } } } } },
      },
      put: {
        tags: ['Channels'],
        summary: 'Update AI configuration',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'string', nullable: true }, model: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Updated config', content: { 'application/json': { schema: { $ref: '#/components/schemas/AIConfig' } } } } },
      },
    },
    '/channels/ai/suggestions': {
      get: {
        tags: ['Channels'],
        summary: 'Get AI prompt suggestions',
        description: 'Generate sample prompt suggestions based on library metadata.',
        responses: { 200: { description: 'Suggestions', content: { 'application/json': { schema: { type: 'object', properties: { suggestions: { type: 'array', items: { type: 'string' } } } } } } } },
      },
    },
    '/channels/regenerate': {
      post: {
        tags: ['Channels'],
        summary: 'Regenerate all channels',
        description: 'Regenerate channels from saved presets or auto-generate by genre.',
        responses: { 200: { description: 'Regenerated', content: { 'application/json': { schema: { type: 'object', properties: { channels_created: { type: 'integer' } } } } } } },
      },
    },
    '/channels/genres': {
      get: {
        tags: ['Channels'],
        summary: 'List genres',
        responses: { 200: { description: 'Genre list', content: { 'application/json': { schema: { type: 'object', properties: { genres: { type: 'array', items: { type: 'string' } } } } } } } },
      },
    },
    '/channels/ratings': {
      get: {
        tags: ['Channels'],
        summary: 'List content ratings',
        responses: { 200: { description: 'Rating list', content: { 'application/json': { schema: { type: 'object', properties: { ratings: { type: 'array', items: { type: 'string' } } } } } } } },
      },
    },
    '/channels/search': {
      get: {
        tags: ['Channels'],
        summary: 'Search library items',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, description: 'Search query' }],
        responses: { 200: { description: 'Search results', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
      },
    },
    '/channels/presets': {
      get: {
        tags: ['Channels'],
        summary: 'List all presets',
        responses: { 200: { description: 'Preset list', content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } } } },
      },
    },
    '/channels/presets/{id}/preview': {
      get: {
        tags: ['Channels'],
        summary: 'Preview preset content',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Preview', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/channels/presets/{id}': {
      post: {
        tags: ['Channels'],
        summary: 'Create channel from preset',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Created channel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Channel' } } } } },
      },
    },
    '/channels/selected-presets': {
      get: {
        tags: ['Channels'],
        summary: 'Get selected presets',
        responses: { 200: { description: 'Selected preset IDs', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } },
      },
    },
    '/channels/generate': {
      post: {
        tags: ['Channels'],
        summary: 'Generate channels from presets',
        description: 'Generate channels from a list of preset IDs. Optionally syncs the library first.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['preset_ids'], properties: { preset_ids: { type: 'array', items: { type: 'string' } }, force_sync: { type: 'boolean', default: false } } } } },
        },
        responses: { 200: { description: 'Generated channels', content: { 'application/json': { schema: { type: 'object', properties: { channels_created: { type: 'integer' }, channels: { type: 'array', items: { $ref: '#/components/schemas/Channel' } } } } } } } },
      },
    },
    '/channels/settings': {
      get: {
        tags: ['Channels'],
        summary: 'Get channel generation settings',
        responses: { 200: { description: 'Settings', content: { 'application/json': { schema: { type: 'object', properties: { max_channels: { type: 'integer' }, selected_presets: { type: 'array', items: { type: 'string' } } } } } } } },
      },
      put: {
        tags: ['Channels'],
        summary: 'Update channel generation settings',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { max_channels: { type: 'integer' }, selected_presets: { type: 'array', items: { type: 'string' } } } } } },
        },
        responses: { 200: { description: 'Updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },

    // ── Schedule ──────────────────────────────────────
    '/schedule': {
      get: {
        tags: ['Schedule'],
        summary: 'Get full schedule',
        description: 'Returns the schedule for all channels, keyed by channel ID.',
        responses: { 200: { description: 'Full schedule', content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'object', properties: { channel: { $ref: '#/components/schemas/Channel' }, blocks: { type: 'array', items: { $ref: '#/components/schemas/ScheduleBlock' } } } } } } } } },
      },
    },
    '/schedule/{channelId}': {
      get: {
        tags: ['Schedule'],
        summary: 'Get channel schedule',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Schedule blocks', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ScheduleBlock' } } } } } },
      },
    },
    '/schedule/{channelId}/now': {
      get: {
        tags: ['Schedule'],
        summary: 'Get currently airing program',
        parameters: [{ name: 'channelId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          200: { description: 'Current program', content: { 'application/json': { schema: { type: 'object', properties: { program: { $ref: '#/components/schemas/ScheduleProgram' }, next: { $ref: '#/components/schemas/ScheduleProgram' }, seekMs: { type: 'integer' } } } } } },
          404: { description: 'No program airing', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/schedule/item/{itemId}': {
      get: {
        tags: ['Schedule'],
        summary: 'Get program details',
        description: 'Get detailed info (overview, genres) for the guide modal.',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Item details', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/schedule/regenerate': {
      post: {
        tags: ['Schedule'],
        summary: 'Force schedule regeneration',
        responses: { 200: { description: 'Regenerated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },

    // ── Playback ──────────────────────────────────────
    '/playback/{channelId}': {
      get: {
        tags: ['Playback'],
        summary: 'Get streaming info',
        description: 'Primary endpoint for the player. Returns the HLS stream URL, seek position, current/next program info, audio/subtitle tracks, and outro detection data.',
        parameters: [
          { name: 'channelId', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'bitrate', in: 'query', schema: { type: 'integer' }, description: 'Target video bitrate (bps)' },
          { name: 'maxWidth', in: 'query', schema: { type: 'integer' }, description: 'Max video width (px)' },
          { name: 'audioStreamIndex', in: 'query', schema: { type: 'integer' }, description: 'Audio track index' },
          { name: 'hevc', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Enable HEVC codec' },
        ],
        responses: { 200: { description: 'Playback info', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlaybackInfo' } } } } },
      },
    },

    // ── Stream ────────────────────────────────────────
    '/stream/{itemId}': {
      get: {
        tags: ['Stream'],
        summary: 'Get HLS master playlist',
        description: 'Initiates an HLS stream for a Jellyfin item. All playlist URLs are rewritten to proxy through this server.',
        parameters: [
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'bitrate', in: 'query', schema: { type: 'integer' }, description: 'Max bitrate (default: 120 Mbps)' },
          { name: 'maxWidth', in: 'query', schema: { type: 'integer' } },
          { name: 'audioStreamIndex', in: 'query', schema: { type: 'integer' } },
          { name: 'subtitleStreamIndex', in: 'query', schema: { type: 'integer' } },
          { name: 'hevc', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'playSessionId', in: 'query', schema: { type: 'string' }, description: 'Pre-fetched session ID' },
          { name: 'mediaSourceId', in: 'query', schema: { type: 'string' }, description: 'Pre-fetched media source ID' },
        ],
        responses: { 200: { description: 'HLS master playlist', content: { 'application/vnd.apple.mpegurl': { schema: { type: 'string' } } } } },
      },
    },
    '/stream/stop': {
      post: {
        tags: ['Stream'],
        summary: 'Stop playback session',
        description: 'Stops streaming and releases server resources. Reports final position to Jellyfin if progress sharing is enabled.',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { itemId: { type: 'string' }, playSessionId: { type: 'string' }, positionMs: { type: 'integer' } } } } },
        },
        responses: { 200: { description: 'Stopped', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, stopped: { type: 'string', nullable: true } } } } } } },
      },
    },
    '/stream/progress': {
      post: {
        tags: ['Stream'],
        summary: 'Report playback progress',
        description: 'Periodic progress report to Jellyfin. Requires `share_playback_progress` setting.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['itemId', 'positionMs'], properties: { itemId: { type: 'string' }, positionMs: { type: 'integer' } } } } },
        },
        responses: { 200: { description: 'Progress reported', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, reported: { type: 'boolean' }, reason: { type: 'string' } } } } } } },
      },
    },
    '/stream/sessions': {
      get: {
        tags: ['Stream'],
        summary: 'List active sessions',
        description: 'Debug endpoint — lists all active playback sessions.',
        responses: { 200: { description: 'Sessions', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' }, sessions: { type: 'array', items: { type: 'object', properties: { itemId: { type: 'string' }, playSessionId: { type: 'string' } } } } } } } } } },
      },
      delete: {
        tags: ['Stream'],
        summary: 'Stop all sessions',
        description: 'Debug endpoint — stops all active playback sessions.',
        responses: { 200: { description: 'Cleared', content: { 'application/json': { schema: { type: 'object', properties: { cleared: { type: 'integer' }, stopped: { type: 'array', items: { type: 'string' } } } } } } } },
      },
    },
    '/images/{itemId}/{imageType}': {
      get: {
        tags: ['Stream'],
        summary: 'Get item image',
        description: 'Proxies a Jellyfin image with optional resizing. Cached for 24 hours.',
        parameters: [
          { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'imageType', in: 'path', required: true, schema: { type: 'string', enum: ['Primary', 'Backdrop', 'Banner', 'Guide', 'Thumb'] } },
          { name: 'maxWidth', in: 'query', schema: { type: 'integer', default: 400 }, description: 'Max image width (px)' },
        ],
        responses: { 200: { description: 'Image binary', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } } },
      },
    },

    // ── Settings ──────────────────────────────────────
    '/settings': {
      get: {
        tags: ['Settings'],
        summary: 'Get all settings',
        responses: { 200: { description: 'All settings', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
      },
      put: {
        tags: ['Settings'],
        summary: 'Update settings',
        description: 'Update one or more settings. Only whitelisted keys are accepted: `selected_presets`, `max_channels`, `preferred_audio_language`, `preferred_subtitle_index`, `share_playback_progress`, `metrics_enabled`, `preview_bg`, `genre_filter`, `content_types`, `rating_filter`, `separate_content_types`, `schedule_auto_update_enabled`, `schedule_auto_update_hours`, `channel_count`, `visible_channels`, `openrouter_api_key`, `openrouter_model`, `unwatched_only`, `iptv_enabled`, `iptv_base_url`, `iptv_timezone`, `schedule_alignment`.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true, example: { preferred_audio_language: 'eng', metrics_enabled: true } } } },
        },
        responses: { 200: { description: 'All settings after update', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
      },
    },
    '/settings/{key}': {
      get: {
        tags: ['Settings'],
        summary: 'Get a single setting',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Setting value', content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string' }, value: {} } } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/settings/factory-reset': {
      post: {
        tags: ['Settings'],
        summary: 'Factory reset',
        description: 'Deletes ALL data: settings, channels, schedules, servers. Rate limited to 90 req/15 min.',
        responses: { 200: { description: 'Reset complete', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },

    // ── Servers ───────────────────────────────────────
    '/servers/discover': {
      get: {
        tags: ['Servers'],
        summary: 'Discover Jellyfin servers',
        description: 'Auto-discover Jellyfin servers on the local network via UDP broadcast and HTTP probes. Takes ~3 seconds.',
        responses: { 200: { description: 'Discovered servers', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, address: { type: 'string' } } } } } } } },
      },
    },
    '/servers': {
      get: {
        tags: ['Servers'],
        summary: 'List configured servers',
        responses: { 200: { description: 'Server list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ServerInfo' } } } } } },
      },
      post: {
        tags: ['Servers'],
        summary: 'Add Jellyfin server',
        description: 'Configure and authenticate a new Jellyfin server. SSRF protection blocks private IP ranges.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['name', 'url', 'username', 'password'], properties: { name: { type: 'string' }, url: { type: 'string', example: 'http://192.168.1.50:8096' }, username: { type: 'string' }, password: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Created server', content: { 'application/json': { schema: { $ref: '#/components/schemas/ServerInfo' } } } } },
      },
    },
    '/servers/{id}': {
      put: {
        tags: ['Servers'],
        summary: 'Update server',
        description: 'Update server details. Include password to re-authenticate.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, username: { type: 'string' }, password: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Updated server', content: { 'application/json': { schema: { $ref: '#/components/schemas/ServerInfo' } } } } },
      },
      delete: {
        tags: ['Servers'],
        summary: 'Delete server',
        description: 'Removes server and all related data (channels, schedules, library cache).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },
    '/servers/{id}/test': {
      post: {
        tags: ['Servers'],
        summary: 'Test server connection',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Test result', content: { 'application/json': { schema: { type: 'object', properties: { connected: { type: 'boolean' }, authenticated: { type: 'boolean' } } } } } } },
      },
    },
    '/servers/{id}/reauthenticate': {
      post: {
        tags: ['Servers'],
        summary: 'Re-authenticate',
        description: 'Update access token with a new password.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Re-authenticated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, authenticated: { type: 'boolean' } } } } } } },
      },
    },
    '/servers/{id}/activate': {
      post: {
        tags: ['Servers'],
        summary: 'Set active server',
        description: 'Switch to this server. Triggers full library sync and channel regeneration.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Activated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },
    '/servers/{id}/resync': {
      post: {
        tags: ['Servers'],
        summary: 'Resync library',
        description: 'Re-sync Jellyfin library and refresh schedules.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Resynced', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, item_count: { type: 'integer' } } } } } } },
      },
    },

    // ── Metrics ───────────────────────────────────────
    '/metrics/start': {
      post: {
        tags: ['Metrics'],
        summary: 'Start watch session',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['client_id'], properties: { client_id: { type: 'string' }, channel_id: { type: 'integer' }, channel_name: { type: 'string' }, item_id: { type: 'string' }, title: { type: 'string' }, series_name: { type: 'string' }, content_type: { type: 'string', enum: ['movie', 'episode'] } } } } },
        },
        responses: { 200: { description: 'Session started', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, session_id: { type: 'string' } } } } } } },
      },
    },
    '/metrics/stop': {
      post: {
        tags: ['Metrics'],
        summary: 'Stop watch session',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['client_id'], properties: { client_id: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Session stopped', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },
    '/metrics/channel-switch': {
      post: {
        tags: ['Metrics'],
        summary: 'Record channel switch',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['client_id'], properties: { client_id: { type: 'string' }, from_channel_id: { type: 'integer' }, from_channel_name: { type: 'string' }, to_channel_id: { type: 'integer' }, to_channel_name: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Recorded', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },
    '/metrics/dashboard': {
      get: {
        tags: ['Metrics'],
        summary: 'Get analytics dashboard',
        parameters: [{ name: 'range', in: 'query', schema: { type: 'string', enum: ['24h', '7d', '30d', 'all'], default: '7d' } }],
        responses: { 200: { description: 'Dashboard data', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/metrics/data': {
      delete: {
        tags: ['Metrics'],
        summary: 'Clear all metrics',
        responses: { 200: { description: 'Cleared', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } } },
      },
    },

    // ── IPTV ──────────────────────────────────────────
    '/iptv/playlist.m3u': {
      get: {
        tags: ['IPTV'],
        summary: 'M3U playlist',
        description: 'M3U playlist for IPTV players (VLC, Kodi, etc.). Includes channel logos, genre groups, and EPG URL.',
        security: [{ ApiKeyQuery: [] }],
        parameters: [{ name: 'token', in: 'query', schema: { type: 'string' }, description: 'API key (if auth enabled)' }],
        responses: { 200: { description: 'M3U playlist', content: { 'audio/x-mpegurl': { schema: { type: 'string' } } } } },
      },
    },
    '/iptv/epg.xml': {
      get: {
        tags: ['IPTV'],
        summary: 'XMLTV EPG',
        description: 'Electronic program guide in XMLTV format. 5-minute server-side cache.',
        security: [{ ApiKeyQuery: [] }],
        parameters: [
          { name: 'token', in: 'query', schema: { type: 'string' } },
          { name: 'hours', in: 'query', schema: { type: 'integer', default: 24, maximum: 48 }, description: 'Hours of guide data' },
        ],
        responses: { 200: { description: 'XMLTV document', content: { 'application/xml': { schema: { type: 'string' } } } } },
      },
    },
    '/iptv/channel/{channelNumber}': {
      get: {
        tags: ['IPTV'],
        summary: 'Live channel stream',
        description: 'HLS live stream for a channel. VOD content is presented with a sliding window so external players cannot scrub.',
        security: [{ ApiKeyQuery: [] }],
        parameters: [
          { name: 'channelNumber', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'token', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'HLS playlist', content: { 'application/vnd.apple.mpegurl': { schema: { type: 'string' } } } },
          404: { description: 'Channel not found' },
          503: { description: 'No program airing (Retry-After: 5)' },
        },
      },
    },
    '/iptv/status': {
      get: {
        tags: ['IPTV'],
        summary: 'IPTV status',
        security: [{ ApiKeyQuery: [] }],
        parameters: [{ name: 'token', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'IPTV config', content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, playlistUrl: { type: 'string' }, epgUrl: { type: 'string' }, channelCount: { type: 'integer' } } } } } } },
      },
    },

    // ── Assets ────────────────────────────────────────
    '/assets/music-list': {
      get: {
        tags: ['Assets'],
        summary: 'List background music tracks',
        security: [],
        responses: { 200: { description: 'Track URLs', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' }, example: ['/api/assets/music/bg1.mp3'] } } } } },
      },
    },
  },
};
