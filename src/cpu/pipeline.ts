import type { Instruction } from './assembler';

// A classic five-stage in-order pipeline: Fetch, Decode, Execute, Memory,
// Writeback. One instruction enters per cycle; data hazards are handled by
// forwarding (toggleable) plus stalls for load-use, and branches resolve in
// Execute with a flush of the two younger slots.

export interface Latch {
  instr: Instruction | null;
  isLoad: boolean;
  rs1Val: number; // register values read at Decode
  rs2Val: number;
  imm: number | null;
  aluOut: number; // ALU result or memory address
  memData: number | null; // filled in at Memory for LW
  storeVal: number; // value SW will write
}

const BUBBLE = (): Latch => ({
  instr: null,
  isLoad: false,
  rs1Val: 0,
  rs2Val: 0,
  imm: null,
  aluOut: 0,
  memData: null,
  storeVal: 0,
});

export type StageCellKind = 'normal' | 'bubble' | 'flushed' | 'stall' | 'idle';

export interface StageCell {
  text: string;
  kind: StageCellKind;
}

export interface CycleSnapshot {
  cycle: number;
  cells: StageCell[]; // [IF, ID, EX, MEM, WB]
  events: string[];
  writtenReg: number | null;
}

const R_TYPE = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR']);

// registers a consumer needs while sitting in Execute (rs2 of a store is only
// needed in Memory, which is why a store right after a load needs no stall)
function exSourceRegs(instr: Instruction): number[] {
  const srcs: number[] = [];
  if (instr.rs1 !== null && instr.op !== 'JMP' && instr.op !== 'NOP' && instr.op !== 'HALT') {
    srcs.push(instr.rs1);
  }
  if ((R_TYPE.has(instr.op) || instr.op === 'BEQ' || instr.op === 'BNE') && instr.rs2 !== null) {
    srcs.push(instr.rs2);
  }
  return srcs;
}

function alu(op: string, a: number, b: number): number {
  switch (op) {
    case 'ADD': return (a + b) | 0;
    case 'SUB': return (a - b) | 0;
    case 'AND': return a & b;
    case 'OR': return a | b;
    case 'XOR': return a ^ b;
    default: return 0;
  }
}

export class Cpu {
  program: Instruction[] = [];
  forwarding = true;

  regs: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  pc = 0;
  mem = new Map<number, number>();

  cycles = 0;
  retired = 0;
  bubbles = 0; // stall bubbles inserted
  squashed = 0; // instruction slots killed by taken branches
  forwards = 0; // values that avoided a stall by forwarding
  flushEvents = 0;
  halted = false;
  done = false;

  private ifId = BUBBLE();
  private idEx = BUBBLE();
  private exMem = BUBBLE();
  private memWb = BUBBLE();
  private stallReg: number | null = null;

  load(program: Instruction[]): void {
    this.program = program;
    this.regs = [0, 0, 0, 0, 0, 0, 0, 0];
    this.pc = 0;
    this.mem = new Map();
    this.ifId = BUBBLE();
    this.idEx = BUBBLE();
    this.exMem = BUBBLE();
    this.memWb = BUBBLE();
    this.cycles = 0;
    this.retired = 0;
    this.bubbles = 0;
    this.squashed = 0;
    this.forwards = 0;
    this.flushEvents = 0;
    this.halted = false;
    this.done = false;
  }

  // Runs one full cycle and returns what each stage looked like, for the UI.
  step(): CycleSnapshot {
    const events: string[] = [];
    let writtenReg: number | null = null;

    // snapshot the instructions occupying each stage this cycle
    const wbCell = this.cellOf(this.memWb);
    const memCell = this.cellOf(this.exMem);
    const exCell = this.cellOf(this.idEx);
    const idCellBase = this.ifId;

    // 1. Writeback: first half of the cycle, so Decode can read the result
    // in the second half without any forwarding.
    const w = this.memWb;
    if (w.instr) {
      this.retired++;
      const value = w.instr.op === 'LW' ? w.memData! : w.aluOut;
      if (w.instr.rd !== null && w.instr.rd !== 0) {
        this.regs[w.instr.rd] = value;
        writtenReg = w.instr.rd;
        events.push(`R${w.instr.rd} = ${value}`);
      } else if (w.instr.rd === 0) {
        events.push(`write to R0 discarded`);
      }
    }

    // 2. Memory: loads read, stores write.
    const m = this.exMem;
    const memWorked: Latch = { ...m };
    if (m.instr && m.instr.op === 'LW') {
      memWorked.memData = this.mem.get(m.aluOut) ?? 0;
      events.push(`mem[${m.aluOut}] read -> R${m.instr.rd}`);
    } else if (m.instr && m.instr.op === 'SW') {
      this.mem.set(m.aluOut, m.storeVal);
      events.push(`R${m.instr.rs2} -> mem[${m.aluOut}]`);
    }

    // 3. Execute: forward missing values, run the ALU, resolve branches.
    const x = this.idEx;
    const exWorked: Latch = { ...x };
    let branchTaken = false;
    let branchTarget = -1;
    if (x.instr) {
      const op = x.instr.op;
      let v1 = x.rs1Val;
      let v2 = x.rs2Val;
      const wantsRs1 = op !== 'JMP' && op !== 'NOP' && op !== 'HALT';
      const wantsRs2 = R_TYPE.has(op) || op === 'BEQ' || op === 'BNE' || op === 'SW';
      if (wantsRs1 && x.instr.rs1 !== null) {
        v1 = this.forwarded(x.instr.rs1, v1, memWorked);
      }
      if (wantsRs2 && x.instr.rs2 !== null) {
        v2 = this.forwarded(x.instr.rs2, v2, memWorked);
      }
      switch (op) {
        case 'ADD': case 'SUB': case 'AND': case 'OR': case 'XOR':
          exWorked.aluOut = alu(op, v1, v2);
          break;
        case 'ADDI':
          exWorked.aluOut = (v1 + x.instr.imm!) | 0;
          break;
        case 'LW': case 'SW':
          exWorked.aluOut = (v1 + x.instr.imm!) | 0;
          if (op === 'SW') exWorked.storeVal = v2;
          break;
        case 'BEQ': case 'BNE': {
          const taken = op === 'BEQ' ? v1 === v2 : v1 !== v2;
          if (taken) {
            branchTaken = true;
            branchTarget = x.instr.imm!;
          }
          break;
        }
        case 'JMP':
          branchTaken = true;
          branchTarget = x.instr.imm!;
          break;
        case 'NOP': case 'HALT':
          break;
      }
    }

    // a taken branch squashes the instruction in Decode and the slot Fetch
    // would have filled, then redirects Fetch to the target this same cycle
    let flushedCell: StageCell | null = null;
    if (branchTaken) {
      this.flushEvents++;
      this.squashed += (idCellBase.instr ? 1 : 0) + 1;
      this.pc = branchTarget;
      // a HALT fetched speculatively before this branch resolved may have
      // stopped fetch; the branch redirects to live code, so re-arm it
      this.halted = false;
      if (idCellBase.instr) {
        flushedCell = { text: idCellBase.instr.text, kind: 'flushed' };
      }
      events.push(`branch taken -> instruction #${branchTarget}, younger slots squashed`);
    }

    // 4. Decode: hazard detection, then read registers (fresh WB values are
    // already visible thanks to the first-half write in step 1).
    const consumer = idCellBase.instr;
    const stall = consumer !== null && !branchTaken && this.detectStall(consumer);
    let idExNew: Latch = BUBBLE();
    if (consumer !== null && !branchTaken && !stall) {
      idExNew = {
        instr: consumer,
        isLoad: consumer.op === 'LW',
        rs1Val: consumer.rs1 !== null && consumer.op !== 'JMP' && consumer.op !== 'NOP' && consumer.op !== 'HALT'
          ? this.regs[consumer.rs1] : 0,
        rs2Val: consumer.rs2 !== null ? this.regs[consumer.rs2] : 0,
        imm: consumer.imm,
        aluOut: 0,
        memData: null,
        storeVal: 0,
      };
    } else if (stall) {
      this.bubbles++;
      events.push(`stall: ${consumer!.op} waits for R${this.stallReg}`);
    }

    // 5. Fetch: suppressed on stalls, naturally redirected on taken branches
    // because step 3 already pointed the pc at the target.
    let ifIdNew: Latch = BUBBLE();
    let ifCell: StageCell = { text: 'idle', kind: 'idle' };
    if (stall) {
      ifIdNew = { ...idCellBase };
      ifCell = { text: 'bubble', kind: 'bubble' };
    } else if (!this.halted) {
      if (this.pc < this.program.length) {
        const fetched = this.program[this.pc];
        ifCell = { text: fetched.text, kind: 'normal' };
        ifIdNew = { ...BUBBLE(), instr: fetched };
        this.pc++;
        if (fetched.op === 'HALT') {
          this.halted = true;
          events.push('HALT fetched: no more instructions enter the pipe');
        }
      } else {
        // the pc ran past the end of the program
        this.halted = true;
      }
    }

    // shift every latch one stage down
    this.memWb = memWorked;
    this.exMem = exWorked;
    this.idEx = idExNew;
    this.ifId = ifIdNew;
    this.cycles++;

    const idCell: StageCell = flushedCell
      ?? (idCellBase.instr
        ? { text: idCellBase.instr.text, kind: stall ? 'stall' : 'normal' }
        : { text: 'idle', kind: 'idle' });

    this.done = this.halted
      && this.ifId.instr === null
      && this.idEx.instr === null
      && this.exMem.instr === null
      && this.memWb.instr === null;

    return {
      cycle: this.cycles,
      cells: [ifCell, idCell, exCell, memCell, wbCell],
      events,
      writtenReg,
    };
  }

  // Runs until the machine finishes or maxCycles run out, for tests.
  runToCompletion(maxCycles = 10000): void {
    let guard = 0;
    while (!this.done && guard++ < maxCycles) this.step();
  }

  private cellOf(latch: Latch): StageCell {
    return latch.instr ? { text: latch.instr.text, kind: 'normal' } : { text: 'idle', kind: 'idle' };
  }

  // Forward a value from the Memory or Writeback stage, nearest producer
  // first. The fallback is the value read from the register file at Decode.
  private forwarded(reg: number, fallback: number, memLatch: Latch): number {
    if (reg === 0) return 0;
    const p1 = memLatch.instr;
    if (p1 && p1.rd === reg) {
      this.forwards++;
      return p1.op === 'LW' ? memLatch.memData! : memLatch.aluOut;
    }
    const p2 = this.memWb.instr;
    if (p2 && p2.rd === reg) {
      this.forwards++;
      return p2.op === 'LW' ? this.memWb.memData ?? 0 : this.memWb.aluOut;
    }
    return fallback;
  }

  // True when the consumer in Decode cannot issue this cycle. With forwarding
  // on, only a load whose result is needed right away in Execute stalls. With
  // forwarding off, any producer still in Execute or Memory stalls. The
  // nearest matching producer decides.
  private detectStall(consumer: Instruction): boolean {
    const srcs = exSourceRegs(consumer);
    if (srcs.length === 0) return false;
    const producers: { latch: Latch; loadUseOnly: boolean }[] = [
      { latch: this.idEx, loadUseOnly: true },
      { latch: this.exMem, loadUseOnly: false },
      { latch: this.memWb, loadUseOnly: false },
    ];
    for (const { latch, loadUseOnly } of producers) {
      const p = latch.instr;
      if (!p || p.rd === null || p.rd === 0) continue;
      if (!srcs.includes(p.rd)) continue;
      if (this.forwarding) {
        if (loadUseOnly && p.op === 'LW') {
          this.stallReg = p.rd;
          return true;
        }
        return false;
      }
      if (latch !== this.memWb) {
        this.stallReg = p.rd;
        return true;
      }
      return false;
    }
    return false;
  }
}
