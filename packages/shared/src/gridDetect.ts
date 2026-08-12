/**
 * Finding the grid a battle map already has printed on it.
 *
 * Most maps you download are drawn with a grid, and calibrating it by hand is
 * three sliders of nudging. This recovers the pitch and offset from the image
 * instead, using classical signal processing rather than anything learned:
 * grid lines are a repeating pattern, so they show up as a strong peak in the
 * autocorrelation of the per-row and per-column edge strength.
 *
 * Pure and deterministic, so the awkward cases are testable.
 */

export interface GridGuess {
  /** Pixel size of one square. */
  size: number;
  offsetX: number;
  offsetY: number;
  /**
   * Rough 0..1 sense of how clear the pattern was. Low means the map probably
   * has no printed grid, and the DM should not be shown a confident answer.
   */
  confidence: number;
}

/** Grid squares outside this range are almost certainly a misread. */
export const MIN_SQUARE_PX = 20;
export const MAX_SQUARE_PX = 400;

/**
 * Sums absolute differences between neighbouring pixels along one axis.
 *
 * A grid line is a row (or column) where lots of pixels change at once, so the
 * result spikes at every line and is otherwise flat-ish.
 */
export function edgeProfile(
  gray: Uint8Array | number[],
  width: number,
  height: number,
  axis: 'x' | 'y',
): number[] {
  const length = axis === 'x' ? width : height;
  const across = axis === 'x' ? height : width;
  const profile = new Array<number>(length).fill(0);

  for (let i = 1; i < length; i++) {
    let sum = 0;
    for (let j = 0; j < across; j++) {
      const a = axis === 'x' ? gray[j * width + i] : gray[i * width + j];
      const b = axis === 'x' ? gray[j * width + i - 1] : gray[(i - 1) * width + j];
      sum += Math.abs(a - b);
    }
    profile[i] = sum / across;
  }

  return profile;
}

/** Removes the slow background trend so autocorrelation sees only the lines. */
function detrend(profile: number[]): number[] {
  const mean = profile.reduce((sum, value) => sum + value, 0) / (profile.length || 1);
  return profile.map((value) => value - mean);
}

/** Below this the profile is flat and any "period" found in it is float noise. */
const FLAT_PROFILE_EPSILON = 1e-6;

/**
 * The repeating period in a profile, by autocorrelation.
 *
 * Three things this has to get right, each of which is a standard way for
 * autocorrelation to mislead:
 *
 * 1. A perfectly periodic signal correlates strongly at every *multiple* of
 *    its period, so the raw maximum is often a harmonic. The fundamental is
 *    recovered by taking the smallest lag that scores nearly as well as the
 *    best one.
 * 2. Prominence is measured as a z-score against all lags, not a ratio. On a
 *    clean grid the mean correlation is negative, and a ratio against a
 *    negative mean is meaningless.
 * 3. A flat profile - a smooth gradient, a blank image - has no signal at all,
 *    and floating-point residue in it can otherwise produce a confident answer
 *    about nothing.
 */
export function dominantPeriod(
  profile: number[],
  minPeriod = MIN_SQUARE_PX,
  maxPeriod = MAX_SQUARE_PX,
): { period: number; strength: number } {
  const signal = detrend(profile);
  const limit = Math.min(maxPeriod, Math.floor(signal.length / 3));
  if (limit < minPeriod) return { period: 0, strength: 0 };

  const energy = signal.reduce((sum, value) => sum + value * value, 0) / (signal.length || 1);
  if (energy < FLAT_PROFILE_EPSILON) return { period: 0, strength: 0 };

  const scores: { lag: number; score: number }[] = [];

  for (let lag = minPeriod; lag <= limit; lag++) {
    let score = 0;
    for (let i = 0; i + lag < signal.length; i++) score += signal[i] * signal[i + lag];
    // Normalised by energy, so the number means "how self-similar", not "how
    // bright the map is".
    scores.push({ lag, score: score / ((signal.length - lag) * energy) });
  }

  if (scores.length === 0) return { period: 0, strength: 0 };

  const values = scores.map((entry) => entry.score);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const deviation = Math.sqrt(variance);

  const peak = scores.reduce((a, b) => (b.score > a.score ? b : a));
  if (peak.score <= 0 || deviation < FLAT_PROFILE_EPSILON) return { period: 0, strength: 0 };

  // The fundamental rather than a harmonic: the earliest lag that is within a
  // whisker of the peak.
  const threshold = peak.score * 0.9;
  const fundamental = scores.find((entry) => entry.score >= threshold) ?? peak;

  // How many standard deviations the peak stands above a typical lag.
  const strength = (peak.score - mean) / deviation;
  return { period: fundamental.lag, strength };
}

/**
 * Where the first line sits, given the period.
 *
 * Tries every offset within one period and keeps whichever lines up with the
 * strongest edges.
 */
export function bestOffset(profile: number[], period: number): number {
  if (period <= 0) return 0;

  let best = 0;
  let bestSum = -Infinity;

  for (let offset = 0; offset < period; offset++) {
    let sum = 0;
    for (let i = offset; i < profile.length; i += period) sum += profile[i];

    if (sum > bestSum) {
      bestSum = sum;
      best = offset;
    }
  }

  return best;
}

/**
 * Guesses the grid from a greyscale image.
 *
 * Both axes are measured independently and then reconciled: a square grid is
 * the overwhelmingly common case, so close-but-unequal readings are averaged,
 * and wildly different ones are reported as low confidence rather than picking
 * a winner arbitrarily.
 */
export function detectGrid(
  gray: Uint8Array | number[],
  width: number,
  height: number,
): GridGuess {
  const columns = edgeProfile(gray, width, height, 'x');
  const rows = edgeProfile(gray, width, height, 'y');

  const x = dominantPeriod(columns);
  const y = dominantPeriod(rows);

  if (x.period === 0 && y.period === 0) return { size: 0, offsetX: 0, offsetY: 0, confidence: 0 };

  // Prefer the stronger axis when they disagree; average when they agree.
  const agree =
    x.period > 0 && y.period > 0 && Math.abs(x.period - y.period) <= Math.max(2, x.period * 0.08);

  const size = agree
    ? Math.round((x.period + y.period) / 2)
    : x.strength >= y.strength
      ? x.period
      : y.period;

  if (size < MIN_SQUARE_PX) return { size: 0, offsetX: 0, offsetY: 0, confidence: 0 };

  const strength = Math.max(x.strength, y.strength);
  // A z-score of 3 is a clear peak; below 1 is indistinguishable from noise.
  const confidence = Math.max(0, Math.min(1, (strength - 1) / 4)) * (agree ? 1 : 0.5);

  return {
    size,
    offsetX: bestOffset(columns, size) % size,
    offsetY: bestOffset(rows, size) % size,
    confidence: Number(confidence.toFixed(2)),
  };
}
