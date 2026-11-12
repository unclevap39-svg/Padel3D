import { type Settings, saveSettings } from '../core/settings';
import type { Difficulty } from '../core/types';

type Screen = 'main' | 'settings' | 'pause' | 'end' | 'install' | 'help' | null;

export interface MenuCallbacks {
  onPlay: () => void;
  onResume: () => void;
  onQuit: () => void;
  /** Back to the home screen (drawn by the Home component). */
  onHome: () => void;
  onSettingsChanged: () => void;
  /** Android/desktop Chrome: triggers the native install prompt if one is available. */
  onInstall: () => Promise<boolean>;
  canInstallNatively: () => boolean;
}

const DIFFS: Array<[Difficulty, string]> = [
  ['easy', 'Facile'],
  ['medium', 'Moyen'],
  ['hard', 'Difficile'],
];

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isMobile(): boolean {
  return isIOS() || /android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
}

/** Menus and full-screen panels: home, settings, pause, end of match, install guide. */
export class Menu {
  private root: HTMLElement;
  private settings: Settings;
  private cb: MenuCallbacks;
  private screen: Screen = null;
  private inMatch = false;
  private endHtml = '';
  /** The finished match was online: "play again" returns to the lobby. */
  private online = false;

  constructor(parent: HTMLElement, settings: Settings, cb: MenuCallbacks) {
    this.settings = settings;
    this.cb = cb;
    this.root = document.createElement('div');
    this.root.className = 'menu hidden';
    parent.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));

    const rotate = document.createElement('div');
    rotate.className = 'rotate-hint';
    rotate.innerHTML = '<div class="rotate-icon"></div><div>Tournez votre appareil en mode paysage</div>';
    parent.appendChild(rotate);
  }

  get current(): Screen {
    return this.screen;
  }

  show(screen: Screen, opts: { inMatch?: boolean; endHtml?: string; online?: boolean } = {}): void {
    if (opts.online !== undefined) this.online = opts.online;
    else if (screen === 'end') this.online = false;
    if (opts.inMatch !== undefined) this.inMatch = opts.inMatch;
    if (screen === 'main') {
      screen = null;
      this.cb.onHome();
    }
    this.screen = screen;
    if (opts.endHtml !== undefined) this.endHtml = opts.endHtml;
    this.root.classList.toggle('hidden', screen === null);
    this.root.dataset.screen = screen ?? '';
    if (screen) this.render();
  }

  private render(): void {
    const s = this.settings;
    let html = '';
    switch (this.screen) {
      case 'main':
        html = `
          <div class="panel home">
            <h1>PADEL <span>3D</span></h1>
            <p class="tag">Double · 2 sets gagnants · vous jouez en bas à droite</p>
            <div class="seg" role="group" aria-label="Difficulté">
              ${DIFFS.map(([d, label]) => `<button data-diff="${d}" class="${s.difficulty === d ? 'on' : ''}">${label}</button>`).join('')}
            </div>
            <button class="primary" data-act="play">Jouer</button>
            <div class="row">
              <button data-act="settings">Réglages</button>
              <button data-act="help">Comment jouer</button>
              ${isStandalone() ? '' : '<button data-act="install">Installer</button>'}
            </div>
          </div>`;
        break;
      case 'settings':
        html = `
          <div class="panel">
            <h2>Réglages</h2>
            <label class="field"><span>Aide au placement <b id="assist-val">${Math.round(s.assist * 100)} %</b></span>
              <input type="range" min="0" max="100" step="5" value="${Math.round(s.assist * 100)}" data-set="assist" /></label>
            <p class="note">À 0 % vous visez et vous déplacez seul. Plus haut, la balle est ramenée dans le terrain et votre joueur se rapproche de la balle quand vous lâchez le joystick.</p>
            <label class="check"><input type="checkbox" data-set="sound" ${s.sound ? 'checked' : ''} /> Sons</label>
            <label class="check"><input type="checkbox" data-set="voice" ${s.voice ? 'checked' : ''} /> Annonce vocale du score</label>
            <label class="check"><input type="checkbox" data-set="haptics" ${s.haptics ? 'checked' : ''} /> Vibration à la frappe <small>(Android uniquement)</small></label>
            <label class="check"><input type="checkbox" data-set="showFps" ${s.showFps ? 'checked' : ''} /> Afficher les images par seconde</label>
            <label class="field"><span>Qualité graphique</span>
              <select data-set="quality">
                ${[
                  ['auto', 'Automatique'],
                  ['high', 'Haute'],
                  ['medium', 'Moyenne'],
                  ['low', 'Basse'],
                ]
                  .map(([v, l]) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${l}</option>`)
                  .join('')}
              </select></label>
            <button class="primary" data-act="back">OK</button>
          </div>`;
        break;
      case 'help':
        html = `
          <div class="panel">
            <h2>Comment jouer</h2>
            <ul class="help">
              <li><b>Se déplacer</b> : posez le pouce gauche n'importe où à gauche et glissez : c'est le joystick.</li>
              <li><b>Frapper</b> : trois boutons à droite. <b>FRAPPE</b> pour le coup normal, <b>LOB</b> pour passer au-dessus des adversaires, <b>SMASH</b> sur une balle haute.</li>
              <li><b>Viser</b> : la balle part du côté où pointe le joystick au moment où vous appuyez ; joystick relâché, elle part droit devant.</li>
              <li><b>Service</b> : appuyez sur FRAPPE. La balle vise le carré en diagonale ; le joystick permet de la décaler. Deux essais.</li>
              <li><b>Règles</b> : un seul rebond au sol ; la balle peut ensuite toucher les vitres. Votre balle doit rebondir au sol chez l'adversaire avant de toucher ses vitres ou son grillage.</li>
              <li>Clavier : flèches pour bouger, Espace frapper, K lob, L smash.</li>
            </ul>
            <button class="primary" data-act="back">OK</button>
          </div>`;
        break;
      case 'pause':
        html = `
          <div class="panel">
            <h2>Pause</h2>
            <button class="primary" data-act="resume">Reprendre</button>
            <div class="row">
              <button data-act="settings">Réglages</button>
              <button data-act="help">Comment jouer</button>
              <button data-act="quit">Quitter le match</button>
            </div>
          </div>`;
        break;
      case 'end':
        html = `
          <div class="panel">
            ${this.endHtml}
            <button class="primary" data-act="${this.online ? 'quit' : 'play'}">${this.online ? 'Retour au salon' : 'Rejouer'}</button>
            ${this.online ? '' : '<div class="row"><button data-act="quit">Menu</button></div>'}
          </div>`;
        break;
      case 'install': {
        const native = this.cb.canInstallNatively();
        const steps = isIOS()
          ? `<ol class="help">
               <li>Ouvrez cette page dans <b>Safari</b>.</li>
               <li>Touchez le bouton <b>Partager</b> <span class="ios-share"></span> en bas de l'écran.</li>
               <li>Choisissez <b>« Sur l'écran d'accueil »</b>, puis <b>Ajouter</b>.</li>
               <li>Lancez <b>Padel 3D</b> depuis l'icône : plein écran, et jouable hors ligne.</li>
             </ol>`
          : `<ol class="help">
               <li>Ouvrez le menu <b>⋮</b> de Chrome.</li>
               <li>Choisissez <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b>.</li>
               <li>Lancez <b>Padel 3D</b> depuis l'icône : plein écran, et jouable hors ligne.</li>
             </ol>`;
        html = `
          <div class="panel">
            <h2>Ajoutez Padel 3D à l'écran d'accueil</h2>
            <p class="note">Installé, le jeu s'ouvre en plein écran paysage, sans barre d'adresse, et fonctionne sans connexion.</p>
            ${native ? '<button class="primary" data-act="install-now">Installer maintenant</button>' : steps}
            <div class="row"><button data-act="install-later">Continuer dans le navigateur</button></div>
          </div>`;
        break;
      }
    }
    this.root.innerHTML = html;
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t) return;
    const diff = t.dataset.diff as Difficulty | undefined;
    if (diff) {
      this.settings.difficulty = diff;
      saveSettings(this.settings);
      this.render();
      return;
    }
    switch (t.dataset.act) {
      case 'play':
        this.cb.onPlay();
        break;
      case 'resume':
        this.cb.onResume();
        break;
      case 'quit':
        this.cb.onQuit();
        break;
      case 'settings':
        this.show('settings');
        break;
      case 'help':
        this.show('help');
        break;
      case 'install':
        this.show('install');
        break;
      case 'back':
        this.show(this.inMatch ? 'pause' : 'main');
        break;
      case 'install-now':
        void this.cb.onInstall().then(() => this.show('main'));
        break;
      case 'install-later':
        this.settings.installDismissed = true;
        saveSettings(this.settings);
        this.show('main');
        break;
    }
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const key = t.dataset.set as keyof Settings | undefined;
    if (!key) return;
    const s = this.settings as unknown as Record<string, unknown>;
    if (t instanceof HTMLInputElement && t.type === 'checkbox') s[key] = t.checked;
    else if (key === 'assist') {
      s[key] = Number(t.value) / 100;
      const v = this.root.querySelector('#assist-val');
      if (v) v.textContent = `${t.value} %`;
    } else s[key] = t.value;
    saveSettings(this.settings);
    this.cb.onSettingsChanged();
  }
}
