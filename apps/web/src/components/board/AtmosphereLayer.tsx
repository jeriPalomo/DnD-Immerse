import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Line, Rect } from 'react-konva';
import { gridToPixel } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';

/**
 * Atmosphere: coloured light from tokens, and weather over the map.
 *
 * Both are cosmetic. Vision has already decided what each player can see — a
 * torch tinting the floor orange must never change who is visible, or two
 * players would disagree about what is on the board.
 */

/** Warm pools of light around whatever is carrying a torch. */
export function LightLayer({
  tokens,
  grid,
  feetPerSquare,
  darkness,
}: {
  tokens: WireToken[];
  grid: { gridSize: number; offsetX: number; offsetY: number };
  feetPerSquare: number;
  darkness: number;
}) {
  const lit = tokens.filter((token) => token.lightBright > 0 || token.lightDim > 0);
  if (lit.length === 0) return null;

  return (
    <Group listening={false}>
      {lit.map((token) => {
        const centre = gridToPixel(
          { x: token.x + token.w / 2, y: token.y + token.h / 2 },
          grid,
        );
        const bright = (token.lightBright / feetPerSquare) * grid.gridSize;
        const dim = Math.max(bright, (token.lightDim / feetPerSquare) * grid.gridSize);
        if (dim <= 0) return null;

        // Stronger in the dark, barely there in daylight - light you cannot
        // see the effect of is just a coloured smear over the map art.
        const strength = 0.18 + darkness * 0.42;

        return (
          <Circle
            key={token.id}
            x={centre.x}
            y={centre.y}
            radius={dim}
            // Additive blending reads as light rather than paint.
            globalCompositeOperation="lighter"
            fillRadialGradientStartPoint={{ x: 0, y: 0 }}
            fillRadialGradientStartRadius={0}
            fillRadialGradientEndPoint={{ x: 0, y: 0 }}
            fillRadialGradientEndRadius={dim}
            fillRadialGradientColorStops={[
              0, hexToRgba(token.lightColor, strength),
              Math.min(0.999, bright / dim), hexToRgba(token.lightColor, strength * 0.55),
              1, hexToRgba(token.lightColor, 0),
            ]}
          />
        );
      })}
    </Group>
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full, 16);

  if (Number.isNaN(value)) return `rgba(255,180,107,${alpha})`;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/* --------------------------------------------------------------- weather */

export type Weather = 'none' | 'rain' | 'storm' | 'snow' | 'fog' | 'ash';

interface Particle {
  x: number;
  y: number;
  speed: number;
  drift: number;
  size: number;
}

const PROFILES: Record<
  Exclude<Weather, 'none' | 'fog'>,
  { count: number; speed: [number, number]; drift: number; size: [number, number]; color: string; streak: boolean }
> = {
  rain: { count: 260, speed: [7, 12], drift: 1.1, size: [7, 14], color: '#9db4d0', streak: true },
  storm: { count: 460, speed: [12, 19], drift: 3.4, size: [10, 20], color: '#b6c8de', streak: true },
  snow: { count: 190, speed: [0.6, 1.6], drift: 0.8, size: [2, 4], color: '#e8eef7', streak: false },
  ash: { count: 150, speed: [0.4, 1.1], drift: 0.5, size: [1.5, 3.5], color: '#8a8079', streak: false },
};

/**
 * Weather over the map.
 *
 * Particles are simulated in view space rather than map space, so panning and
 * zooming does not drag the rain sideways with the terrain — it falls past the
 * camera the way weather actually does.
 */
export function WeatherLayer({
  weather,
  intensity,
  width,
  height,
}: {
  weather: Weather;
  intensity: number;
  width: number;
  height: number;
}) {
  const [, setTick] = useState(0);
  const particles = useRef<Particle[]>([]);
  const frame = useRef<number>(0);

  const profile = weather === 'none' || weather === 'fog' ? null : PROFILES[weather];

  const count = useMemo(
    () => (profile ? Math.round(profile.count * Math.max(0.1, intensity)) : 0),
    [profile, intensity],
  );

  useEffect(() => {
    if (!profile || width <= 0 || height <= 0) {
      particles.current = [];
      return;
    }

    const random = (range: [number, number]) => range[0] + Math.random() * (range[1] - range[0]);
    particles.current = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      speed: random(profile.speed),
      drift: (Math.random() - 0.5) * profile.drift,
      size: random(profile.size),
    }));

    let running = true;
    const step = () => {
      if (!running) return;

      for (const p of particles.current) {
        p.y += p.speed;
        p.x += p.drift;
        // Wrap rather than respawn, so the field never thins out.
        if (p.y > height) {
          p.y = -p.size;
          p.x = Math.random() * width;
        }
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
      }

      setTick((t) => (t + 1) % 1000);
      frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      running = false;
      cancelAnimationFrame(frame.current);
    };
  }, [profile, count, width, height]);

  if (weather === 'none') return null;

  // Fog is a flat wash rather than particles; drifting blobs read as smudges.
  if (weather === 'fog') {
    return (
      <Group listening={false}>
        <Rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="#c8d2dc"
          opacity={0.1 + intensity * 0.3}
        />
      </Group>
    );
  }

  if (!profile) return null;

  return (
    <Group listening={false} opacity={0.25 + intensity * 0.45}>
      {particles.current.map((p, i) =>
        profile.streak ? (
          <Line
            key={i}
            points={[p.x, p.y, p.x - p.drift * 2, p.y - p.size]}
            stroke={profile.color}
            strokeWidth={1.1}
            lineCap="round"
          />
        ) : (
          <Circle key={i} x={p.x} y={p.y} radius={p.size / 2} fill={profile.color} />
        ),
      )}
    </Group>
  );
}
