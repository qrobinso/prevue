import type { AudioTrackInfo, SubtitleTrackInfo } from '../../types';

const LANG_NAMES: Record<string, string> = {
  eng: 'English', en: 'English',
  spa: 'Spanish', es: 'Spanish',
  fra: 'French', fr: 'French',
  deu: 'German', de: 'German',
  ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese',
  jpn: 'Japanese', ja: 'Japanese',
  kor: 'Korean', ko: 'Korean',
  zho: 'Chinese', zh: 'Chinese',
  rus: 'Russian', ru: 'Russian',
  ara: 'Arabic', ar: 'Arabic',
  hin: 'Hindi', hi: 'Hindi',
  und: 'Unknown',
};

export function formatAudioTrackNameFromServer(track: AudioTrackInfo): string {
  if (track.name && track.name !== 'und' && !/^Track \d+$/i.test(track.name)) {
    return track.name;
  }
  const lang = (track.language || 'und').toLowerCase();
  return LANG_NAMES[lang] ?? lang.toUpperCase();
}

export function formatSubtitleTrackNameFromServer(track: SubtitleTrackInfo): string {
  if (track.name && track.name !== 'und' && !/^Subtitle \d+$/i.test(track.name)) {
    return track.name;
  }
  const lang = (track.language || 'und').toLowerCase();
  return LANG_NAMES[lang] ?? lang.toUpperCase();
}
