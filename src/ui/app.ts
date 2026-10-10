import { assemble, type Instruction } from '../cpu/assembler';
import { Cpu, type CycleSnapshot } from '../cpu/pipeline';

const REPO_URL = 'https://github.com/rajpalgelot-tech/cpu-pipeline-simulator';
const GUIDE_URL = REPO_URL + '/blob/main/GUIDE.md';

const STAGES = ['IF', 'ID', 'EX', 'MEM', 'WB'] as const;

const EXAMPLES: { name: string; source: string }[] = [
  {
    name: 'Fibonacci',
    source: `# R1 and R2 walk the sequence, R3 counts down
ADDI R1, R0, 0      # a = 0
ADDI R2, R0, 1      # b = 1
ADDI R3, R0, 8      # count = 8
loop:
ADD R4, R1, R2      # t = a + b
ADD R1, R2, R0      # a = b
ADD R2, R4, R0      # b = t
ADDI R3, R3, -1
BNE R3, R0, loop
HALT`,
  },
  {
    name: 'Load-use demo',
    source: `# a load whose result is needed right away costs one bubble
ADDI R1, R0, 100
SW R0, 0(R1)
LW R2, 0(R1)
ADD R3, R2, R1
SW R3, 4(R1)
HALT`,
  },
  {
    name: 'Sum an array',
    source: `# store 1..5 into memory, then add them back up
ADDI R4, R0, 200
ADDI R2, R0, 1
SW R2, 0(R4)
ADDI R4, R4, 4
ADDI R2, R2, 1
SW R2, 0(R4)
ADDI R4, R4, 4
ADDI R2, R2, 1
SW R2, 0(R4)
ADDI R4, R4, 4
ADDI R2, R2, 1
SW R2, 0(R4)
ADDI R4, R4, 4
ADDI R2, R2, 1
SW R2, 0(R4)
ADDI R1, R0, 0
ADDI R4, R0, 200
ADDI R5, R0, 5
loop:
LW R2, 0(R4)
ADD R1, R1, R2
ADDI R4, R4, 4
ADDI R5, R5, -1
BNE R5, R0, loop
SW R1, 300(R0)
HALT`,
  },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

export function startApp(root: HTMLElement): void {
  const cpu = new Cpu();
  let program: Instruction[] = [];
  let history: CycleSnapshot[] = [];
  let timer: number | null = null;
  let loadErrors: string[] = [];

  // -- chrome -----------------------------------------------------------------

  const header = el('header', 'top');
  const brand = el('div', 'brand');
  brand.append(
    el('span', 'brand-name', 'Pipeline'),
    el('span', 'brand-sub', 'a five-stage CPU you can watch chase hazards'),
  );
  const nav = el('nav', 'top-nav');
  const repoLink = el('a', 'nav-link', 'GitHub');
  repoLink.href = REPO_URL;
  repoLink.target = '_blank';
  const guideLink = el('a', 'nav-link', 'Guide');
  guideLink.href = GUIDE_URL;
  guideLink.target = '_blank';
  nav.append(repoLink, guideLink);
  header.append(brand, nav);

  const controls = el('section', 'controls');
  const runBtn = el('button', 'btn primary', 'Run');
  const stepBtn = el('button', 'btn', 'Step');
  const resetBtn = el('button', 'btn', 'Reset');
  const assembleBtn = el('button', 'btn', 'Assemble & load');
  const speedWrap = el('label', 'speed-wrap');
  const speed = el('input', 'speed') as HTMLInputElement;
  speed.type = 'range';
  speed.min = '1';
  speed.max = '20';
  speed.value = '4';
  speedWrap.append('speed ', speed, el('span', 'speed-val mono', '4 c/s'));
  const fwdWrap = el('label', 'fwd-wrap');
  const fwd = el('input') as HTMLInputElement;
  fwd.type = 'checkbox';
  fwd.checked = true;
  fwdWrap.append(fwd, ' forwarding');
  const exampleWrap = el('div', 'examples');
  const exampleButtons = EXAMPLES.map((ex) => {
    const b = el('button', 'btn tiny', ex.name);
    b.addEventListener('click', () => {
      editor.value = ex.source;
      assembleAndLoad();
    });
    return b;
  });
  exampleWrap.append('examples:', ...exampleButtons);
  controls.append(assembleBtn, runBtn, stepBtn, resetBtn, speedWrap, fwdWrap, exampleWrap);

  const banner = el('section', 'banner idle');
  const bannerText = el('span', 'banner-text');
  banner.append(bannerText);

  const main = el('main', 'layout');
  const editorPanel = el('section', 'panel editor-panel');
  editorPanel.append(el('h2', 'panel-title', 'program'));
  const editor = el('textarea', 'editor') as HTMLTextAreaElement;
  editor.spellcheck = false;
  editor.value = EXAMPLES[0].source;
  const errorMsg = el('div', 'error-msg');
  errorMsg.hidden = true;
  editorPanel.append(editor, errorMsg);

  const pipePanel = el('section', 'panel pipe-panel');
  pipePanel.append(el('h2', 'panel-title', 'pipeline diagram'));
  const pipeScroll = el('div', 'pipe-scroll');
  const pipeTable = el('div', 'pipe-table');
  pipeScroll.append(pipeTable);
  pipePanel.append(pipeScroll);

  const sidePanel = el('section', 'side');
  const regPanel = el('div', 'panel');
  regPanel.append(el('h2', 'panel-title', 'registers'));
  const regGrid = el('div', 'reg-grid');
  regPanel.append(regGrid);
  const memPanel = el('div', 'panel');
  memPanel.append(el('h2', 'panel-title', 'data memory'));
  const memList = el('div', 'mem-list');
  memPanel.append(memList);
  const statPanel = el('div', 'panel');
  statPanel.append(el('h2', 'panel-title', 'totals'));
  const statGrid = el('div', 'stat-grid');
  statPanel.append(statGrid);
  sidePanel.append(regPanel, memPanel, statPanel);

  const logPanel = el('section', 'panel log-panel');
  logPanel.append(el('h2', 'panel-title', 'cycle log'));
  const logList = el('ul', 'log-list');
  logPanel.append(logList);

  main.append(editorPanel, pipePanel, sidePanel);
  const footer = el('footer', 'foot', 'Pipeline is a teaching model: eight registers, word memory, branches resolved in Execute. R0 is hardwired to zero.');
  root.append(header, controls, banner, main, logPanel, footer);

  // -- rendering ----------------------------------------------------------------

  const regCells: HTMLElement[] = [];
  for (let i = 0; i < 8; i++) {
    const cell = el('div', 'reg-cell mono', `R${i} = 0`);
    regGrid.append(cell);
    regCells.push(cell);
  }

  const statCells = new Map<string, HTMLElement>();
  for (const key of ['cycles', 'retired', 'CPI', 'bubbles', 'flushed', 'forwards']) {
    const cell = el('div', 'stat-cell');
    cell.append(el('span', 'stat-key', key), el('span', 'stat-val mono', '0'));
    statGrid.append(cell);
    statCells.set(key, cell.lastElementChild as HTMLElement);
  }

  function render(): void {
    // banner
    if (loadErrors.length > 0) {
      banner.className = 'banner bad';
      bannerText.textContent = loadErrors[0] + (loadErrors.length > 1 ? ` (+${loadErrors.length - 1} more)` : '');
    } else if (cpu.done) {
      const cpi = cpu.retired > 0 ? (cpu.cycles / cpu.retired).toFixed(2) : '-';
      banner.className = 'banner ok';
      const bubbleWord = cpu.bubbles === 1 ? 'bubble' : 'bubbles';
      bannerText.textContent =
        `done: ${cpu.cycles} cycles, ${cpu.retired} retired, CPI ${cpi} | ${cpu.bubbles} stall ${bubbleWord}, ${cpu.squashed} flushed, ${cpu.forwards} forwarded`;
    } else if (timer !== null) {
      banner.className = 'banner busy';
      bannerText.textContent = `running: cycle ${cpu.cycles}`;
    } else {
      banner.className = 'banner idle';
      bannerText.textContent = cpu.cycles === 0
        ? `ready: ${program.length} instructions loaded. Step one cycle at a time or press Run.`
        : `paused at cycle ${cpu.cycles}`;
    }

    // pipeline diagram
    pipeTable.replaceChildren();
    const head = el('div', 'pipe-row pipe-head');
    head.append(el('span', 'pipe-cycle mono', 'cycle'));
    for (const s of STAGES) head.append(el('span', 'pipe-stage mono', s));
    pipeTable.append(head);
    const shown = history.slice(-160);
    for (const snap of shown) {
      const row = el('div', 'pipe-row' + (snap === history[history.length - 1] ? ' latest' : ''));
      row.append(el('span', 'pipe-cycle mono', String(snap.cycle)));
      snap.cells.forEach((cell, i) => {
        const chip = el('span', `chip ${cell.kind}`, cell.text);
        chip.title = `${STAGES[i]}: ${cell.text}`;
        row.append(chip);
      });
      pipeTable.append(row);
    }
    pipeScroll.scrollTop = pipeScroll.scrollHeight;

    // registers
    const lastWritten = history.length > 0 ? history[history.length - 1].writtenReg : null;
    cpu.regs.forEach((v, i) => {
      const hex = (v >>> 0).toString(16).padStart(8, '0');
      regCells[i].textContent = `R${i} = ${v}`;
      regCells[i].title = `0x${hex}`;
      regCells[i].className = 'reg-cell mono' + (i === lastWritten ? ' written' : '') + (v !== 0 ? ' nonzero' : '');
    });

    // memory
    memList.replaceChildren();
    const addrs = [...cpu.mem.keys()].sort((a, b) => a - b);
    if (addrs.length === 0) {
      memList.append(el('div', 'mem-empty', 'no stores yet'));
    } else {
      for (const addr of addrs) {
        memList.append(el('div', 'mem-row mono', `mem[${addr}] = ${cpu.mem.get(addr)}`));
      }
    }

    // stats
    const cpi = cpu.retired > 0 ? (cpu.cycles / cpu.retired).toFixed(2) : '-';
    statCells.get('cycles')!.textContent = String(cpu.cycles);
    statCells.get('retired')!.textContent = String(cpu.retired);
    statCells.get('CPI')!.textContent = cpi;
    statCells.get('bubbles')!.textContent = String(cpu.bubbles);
    statCells.get('flushed')!.textContent = String(cpu.squashed);
    statCells.get('forwards')!.textContent = String(cpu.forwards);

    // log
    logList.replaceChildren();
    const recent: string[] = [];
    for (let i = history.length - 1; i >= 0 && recent.length < 10; i--) {
      for (const e of [...history[i].events].reverse()) recent.push(`c${history[i].cycle}  ${e}`);
    }
    for (const line of recent.slice(0, 10)) {
      logList.append(el('li', 'log-item', line));
    }
    if (recent.length === 0) {
      logList.append(el('li', 'log-item empty', 'events will appear here as the pipeline runs'));
    }

    stepBtn.disabled = cpu.done || timer !== null || loadErrors.length > 0;
    runBtn.textContent = timer !== null ? 'Pause' : 'Run';
    runBtn.classList.toggle('primary', timer === null);
  }

  // -- actions ----------------------------------------------------------------

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function assembleAndLoad(): void {
    stopTimer();
    const res = assemble(editor.value);
    if (!res.ok) {
      loadErrors = res.errors;
      program = [];
      history = [];
      render();
      return;
    }
    loadErrors = [];
    program = res.program;
    cpu.forwarding = fwd.checked;
    cpu.load(program);
    history = [];
    render();
  }

  function stepOnce(): void {
    if (cpu.done || loadErrors.length > 0) {
      if (cpu.done) stopTimer();
      render();
      return;
    }
    history.push(cpu.step());
    if (cpu.done) stopTimer();
    render();
  }

  function toggleRun(): void {
    if (timer !== null) {
      stopTimer();
      render();
      return;
    }
    if (cpu.done || loadErrors.length > 0) return;
    const ms = Math.round(1000 / Number(speed.value));
    timer = window.setInterval(stepOnce, ms);
    render();
  }

  // -- wiring ----------------------------------------------------------------

  assembleBtn.addEventListener('click', assembleAndLoad);
  runBtn.addEventListener('click', toggleRun);
  stepBtn.addEventListener('click', stepOnce);
  resetBtn.addEventListener('click', () => {
    stopTimer();
    cpu.load(program);
    history = [];
    render();
  });
  speed.addEventListener('input', () => {
    (speedWrap.querySelector('.speed-val') as HTMLElement).textContent = `${speed.value} c/s`;
    if (timer !== null) {
      stopTimer();
      timer = window.setInterval(stepOnce, Math.round(1000 / Number(speed.value)));
    }
  });
  fwd.addEventListener('change', () => {
    cpu.forwarding = fwd.checked;
    render();
  });

  assembleAndLoad();
}
