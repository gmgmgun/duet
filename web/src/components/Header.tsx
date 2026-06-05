export function Header({ running }: { running: boolean }) {
  return (
    <header className="h-[52px] flex items-center gap-4 px-5 border-b border-line bg-gradient-to-b from-[#0d1218] to-[#090d11]">
      <div className="font-disp font-bold text-[17px] tracking-[.14em]">
        DUET
        <span className="text-faint px-[6px]">—</span>
        <span className="text-claude">CLAUDE</span>
        <span className="text-faint px-[6px]">×</span>
        <span className="text-codex">CODEX</span>
        <span className="inline-block w-[9px] h-4 bg-ok ml-2 align-[-2px] animate-blink" />
      </div>
      <div className="ml-auto flex items-center gap-2 text-[11px] text-dim tracking-[.08em]">
        <span
          className={
            running
              ? 'w-2 h-2 rounded-full bg-claude shadow-[0_0_8px_var(--color-claude)] animate-led-busy'
              : 'w-2 h-2 rounded-full bg-ok shadow-[0_0_8px_var(--color-ok)] animate-led'
          }
        />
        <span>{running ? 'RUNNING' : 'IDLE'}</span>
      </div>
    </header>
  );
}
