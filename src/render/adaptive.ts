import type { QualityTier, Stage } from './stage';

const ORDER: QualityTier[] = ['low', 'medium', 'high'];

/**
 * Keeps the frame rate up by trading resolution first, then shadows and filtering. Measures over
 * windows of about a second so a single hitch does not trigger a change.
 */
export class AdaptiveQuality {
  enabled = true;
  fps = 60;
  private frames = 0;
  private time = 0;
  private goodWindows = 0;
  private stage: Stage;
  /** Highest tier the controller may climb back to. */
  private ceiling: QualityTier;

  constructor(stage: Stage, ceiling: QualityTier) {
    this.stage = stage;
    this.ceiling = ceiling;
  }

  frame(dt: number): void {
    this.frames++;
    this.time += dt;
    if (this.time < 1.2) return;
    this.fps = this.frames / this.time;
    this.frames = 0;
    this.time = 0;
    if (!this.enabled) return;
    const s = this.stage;
    if (this.fps < 48) {
      this.goodWindows = 0;
      if (s.resolutionScale > 0.62) {
        s.resolutionScale = Math.max(0.6, s.resolutionScale - (this.fps < 30 ? 0.2 : 0.1));
        s.resize();
      } else {
        const i = ORDER.indexOf(s.tier);
        if (i > 0) {
          s.resolutionScale = 0.8;
          s.applyTier(ORDER[i - 1]);
          // Do not climb back to a tier that proved too heavy: avoids see-sawing.
          this.ceiling = ORDER[i - 1];
        }
      }
    } else if (this.fps > 57) {
      // Climb back slowly: only after several good windows in a row.
      if (++this.goodWindows >= 5) {
        this.goodWindows = 0;
        if (s.resolutionScale < 1) {
          s.resolutionScale = Math.min(1, s.resolutionScale + 0.1);
          s.resize();
        } else {
          const i = ORDER.indexOf(s.tier);
          if (i < ORDER.indexOf(this.ceiling)) s.applyTier(ORDER[i + 1]);
        }
      }
    } else {
      this.goodWindows = 0;
    }
  }
}
