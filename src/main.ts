import { Game } from './core/game';
import { loadSettings } from './core/settings';
import { initPhysics } from './physics/world';
import type { QualityTier } from './render/stage';
import { isMobile, isStandalone } from './ui/menu';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const fill = document.getElementById('loading-fill') as HTMLElement;
const text = document.getElementById('loading-text') as HTMLElement;
function progress(p: number, label: string): void {
  fill.style.width = `${Math.round(p * 100)}%`;
  text.textContent = label;
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Android / desktop Chrome hand us the install prompt; keep it for the install screen.
let installEvent: InstallPromptEvent | null = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallPromptEvent;
});

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const settings = loadSettings();
  progress(0.1, 'Moteur physique…');
  await initPhysics();
  progress(0.45, 'Terrain et éclairage…');
  await nextFrame();
  const q = params.get('q');
  const game = new Game({
    canvas: document.getElementById('game') as HTMLCanvasElement,
    ui: document.getElementById('ui') as HTMLElement,
    settings,
    forceTier: q === 'low' || q === 'medium' || q === 'high' ? (q as QualityTier) : undefined,
    canInstallNatively: () => installEvent !== null,
    promptInstall: async () => {
      if (!installEvent) return false;
      await installEvent.prompt();
      const choice = await installEvent.userChoice;
      installEvent = null;
      return choice.outcome === 'accepted';
    },
  });
  progress(0.8, 'Joueurs…');
  await nextFrame();
  game.frame(0.016); // compile shaders before revealing the scene
  progress(1, 'Prêt');
  await nextFrame();
  document.getElementById('loading')?.classList.add('done');
  // Opened in a mobile browser tab: suggest installing first (once).
  const suggestInstall = isMobile() && !isStandalone() && !settings.installDismissed && !params.has('noinstall');
  game.showMenu(suggestInstall);
  game.start();
  (window as unknown as { __padel: unknown }).__padel = game;
  if (params.has('autoplay')) game.startMatch();
}

boot().catch((err) => {
  console.error(err);
  text.textContent = 'Impossible de démarrer le jeu sur cet appareil (WebGL 2 requis).';
});
