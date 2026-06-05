interface StepperProps {
  value: string; // 자유 입력 허용 — 클램프는 버튼/제출 시
  min?: number;
  max?: number;
  onChange: (v: string) => void;
}

const stepCls =
  'w-[30px] flex-none bg-bg border border-line text-faint cursor-pointer font-mono text-sm leading-none ' +
  'select-none transition-colors duration-150 hover:border-bright hover:text-fg active:text-ok';

/** 숫자 스테퍼 — 네이티브 spin 버튼을 −/＋ 버튼으로 대체 */
export function Stepper({ value, min = 1, max = 30, onChange }: StepperProps) {
  const step = (d: number) => {
    const v = (Number(value) || min) + d;
    onChange(String(Math.min(max, Math.max(min, v))));
  };
  return (
    <div className="flex focus-within:[&>*]:border-bright">
      <button type="button" tabIndex={-1} className={`${stepCls} rounded-l-[3px]`} onClick={() => step(-1)}>
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 text-center bg-bg text-fg border-y border-line font-mono text-[13.5px] py-2 px-[2px]
          outline-none transition-colors duration-150
          [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" tabIndex={-1} className={`${stepCls} rounded-r-[3px]`} onClick={() => step(1)}>
        ＋
      </button>
    </div>
  );
}
