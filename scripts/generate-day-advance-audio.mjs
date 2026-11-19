import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Original quiet stopwatch-like mechanical tick: a dry, rapidly damped impact.
// No second note, sustained tone, external sample or volume normalization.
const source = "aevalsrc='0.065*(sin(2*PI*1800*t)*exp(-170*t)+0.42*sin(2*PI*4100*t)*exp(-270*t)+0.18*sin(2*PI*6700*t)*exp(-400*t))':s=48000:d=0.07,afade=t=in:d=0.0005,afade=t=out:st=0.045:d=0.025";
for (const [ext, codec] of [['ogg', 'libvorbis'], ['mp3', 'libmp3lame']]) {
  const output = fileURLToPath(new URL(`../packages/client/public/audio/sfx/day_advance.${ext}`, import.meta.url));
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-c:a', codec, '-q:a', '4', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${ext}`);
}
