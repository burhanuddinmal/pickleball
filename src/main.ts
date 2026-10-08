import './ui/styles.css';
import { GameManager } from './game/GameManager';
import { initPlatform } from './platforms';

async function boot(): Promise<void> {
  const bar = document.getElementById('loading-bar')!;
  const loading = document.getElementById('loading')!;
  const setProgress = (p: number) => (bar.style.width = `${Math.round(p * 100)}%`);

  try {
    setProgress(0.1);
    await initPlatform();
    setProgress(0.2);

    const game = new GameManager(
      document.getElementById('game-root')!,
      document.getElementById('ui-root')!,
      (p: number) => setProgress(0.2 + p * 0.7)
    );
    await game.init();
    setProgress(1);

    // Let the bar visibly finish, then reveal the title screen.
    setTimeout(() => {
      loading.classList.add('hidden');
      game.start();
    }, 250);
    if (import.meta.env.DEV) (window as unknown as { game: GameManager }).game = game;
  } catch (err) {
    console.error(err);
    loading.querySelector('.loading-text')!.textContent = 'Sorry — this browser could not start WebGL.';
  }
}

void boot();
