import { defaultOutputPath, toPath, toUri } from '../uri';

describe('toPath', () => {
  it('strips the scheme and decodes escapes', () => {
    expect(toPath('file:///var/mobile/My%20Recording.m4a')).toBe('/var/mobile/My Recording.m4a');
  });

  it('passes a plain path through', () => {
    expect(toPath('/data/user/0/app/cache/a.wav')).toBe('/data/user/0/app/cache/a.wav');
  });

  it('falls back to the raw path when the escapes are malformed', () => {
    expect(toPath('file:///tmp/100%.m4a')).toBe('/tmp/100%.m4a');
  });
});

describe('toUri', () => {
  it('escapes each segment but keeps the separators', () => {
    expect(toUri('/var/My Recording.wav')).toBe('file:///var/My%20Recording.wav');
  });

  it('leaves something that is already a URI alone', () => {
    expect(toUri('file:///a/b.wav')).toBe('file:///a/b.wav');
  });
});

describe('defaultOutputPath', () => {
  it('keeps the extension so the encoding follows the input', () => {
    expect(defaultOutputPath('/cache/recording.m4a')).toBe('/cache/recording-clear.m4a');
  });

  it('writes WAV when there is no extension to follow', () => {
    expect(defaultOutputPath('/cache/recording')).toBe('/cache/recording-clear.wav');
  });

  it('does not mistake a dotfile for an extension', () => {
    expect(defaultOutputPath('/cache/.hidden')).toBe('/cache/.hidden-clear.wav');
  });

  it('handles a bare filename with no directory', () => {
    expect(defaultOutputPath('recording.wav')).toBe('recording-clear.wav');
  });
});
