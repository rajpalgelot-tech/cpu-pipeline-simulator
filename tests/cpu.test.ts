import { describe, expect, it } from 'vitest';
import { assemble } from '../src/cpu/assembler';
import { Cpu } from '../src/cpu/pipeline';

function build(source: string, forwarding = true): Cpu {
  const res = assemble(source);
  if (!res.ok) throw new Error(res.errors.join('; '));
  const cpu = new Cpu();
  cpu.forwarding = forwarding;
  cpu.load(res.program);
  return cpu;
}

// -- assembler ------------------------------------------------------------------

describe('assembler', () => {
  it('parses every instruction form', () => {
    const res = assemble(`
start:
      ADD R1, R2, R3
      SUB R4, R5, R6
      AND R1, R2, R3
      OR R1, R2, R3
      XOR R1, R2, R3
      ADDI R1, R2, -5
      LW R2, 0(R4)
      SW R2, 12(R4)
      BEQ R1, R2, end
      BNE R1, R2, end
      JMP start
      NOP
      HALT
end:
    `);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.program).toHaveLength(13);
    expect(res.program[0]).toMatchObject({ op: 'ADD', rd: 1, rs1: 2, rs2: 3 });
    expect(res.program[6]).toMatchObject({ op: 'LW', rd: 2, rs1: 4, imm: 0 });
    expect(res.program[7]).toMatchObject({ op: 'SW', rs1: 4, rs2: 2, imm: 12 });
    expect(res.program[8].imm).toBe(13); // end points one past the last instruction
    expect(res.program[10].imm).toBe(0); // start
  });

  it('resolves labels to instruction indexes', () => {
    const res = assemble(`
      ADDI R1, R0, 1
loop: ADDI R1, R1, 1
      BNE R1, R0, loop
      JMP done
      ADDI R2, R0, 9
done: HALT
    `);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.program[2].imm).toBe(1); // loop is the second instruction
    expect(res.program[3].imm).toBe(5); // done points at HALT
  });

  it('accepts a label pointing past the last instruction', () => {
    const res = assemble('BEQ R0, R0, end\nHALT\nend:');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.program[0].imm).toBe(2);
  });

  it('rejects unknown mnemonics, bad registers, and missing labels', () => {
    expect(assemble('MULT R1, R2, R3').ok).toBe(false);
    expect(assemble('ADD R9, R1, R2').ok).toBe(false);
    expect(assemble('BEQ R1, R2, nowhere').ok).toBe(false);
    expect(assemble('ADD R1, R2').ok).toBe(false);
    expect(assemble('LW R1, 0(R9)').ok).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const res = assemble('# a whole line comment\n\n  ADD R1, R2, R3  # trailing\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.program).toHaveLength(1);
  });
});

// -- basic execution --------------------------------------------------------------

describe('basic execution', () => {
  it('retires independent instructions at one per cycle after the fill', () => {
    const cpu = build('ADDI R1, R0, 5\nADDI R2, R0, 7\nHALT');
    cpu.runToCompletion();
    expect(cpu.done).toBe(true);
    expect(cpu.regs[1]).toBe(5);
    expect(cpu.regs[2]).toBe(7);
    expect(cpu.cycles).toBe(7); // 3 instructions, first WB at cycle 5, no stalls
    expect(cpu.retired).toBe(3);
    expect(cpu.bubbles).toBe(0);
  });

  it('stops fetching when the pc runs past the end without HALT', () => {
    const cpu = build('ADDI R1, R0, 3');
    cpu.runToCompletion();
    expect(cpu.done).toBe(true);
    expect(cpu.retired).toBe(1);
    expect(cpu.regs[1]).toBe(3);
  });

  it('keeps R0 hardwired to zero', () => {
    const cpu = build('ADDI R0, R0, 5\nADD R1, R0, R0\nHALT');
    cpu.runToCompletion();
    expect(cpu.regs[0]).toBe(0);
    expect(cpu.regs[1]).toBe(0);
  });

  it('computes ALU operations and negative immediates', () => {
    const cpu = build('ADDI R1, R0, 12\nADDI R2, R0, -4\nADD R3, R1, R2\nSUB R4, R1, R2\nAND R5, R1, R2\nXOR R6, R1, R2\nOR R7, R1, R2\nHALT');
    cpu.runToCompletion();
    expect(cpu.regs[3]).toBe(8);
    expect(cpu.regs[4]).toBe(16);
    expect(cpu.regs[5]).toBe(12 & -4);
    expect(cpu.regs[6]).toBe(12 ^ -4);
    expect(cpu.regs[7]).toBe(12 | -4);
  });
});

// -- data hazards ------------------------------------------------------------------

describe('data hazards with forwarding', () => {
  it('forwards a back-to-back ALU result with no stall', () => {
    const cpu = build('ADDI R1, R0, 5\nADD R2, R1, R1\nHALT');
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(10);
    expect(cpu.bubbles).toBe(0);
    expect(cpu.forwards).toBeGreaterThanOrEqual(1);
    expect(cpu.cycles).toBe(7);
  });

  it('inserts exactly one bubble for a load used immediately', () => {
    const cpu = build('ADDI R1, R0, 100\nSW R0, 0(R1)\nLW R2, 0(R1)\nADD R3, R2, R1\nHALT');
    cpu.runToCompletion();
    expect(cpu.bubbles).toBe(1);
    expect(cpu.regs[3]).toBe(100); // loaded 0 plus base 100
    expect(cpu.done).toBe(true);
  });

  it('needs no bubble when the load result is used one slot later', () => {
    const cpu = build('ADDI R1, R0, 100\nLW R2, 0(R1)\nNOP\nADD R3, R2, R2\nHALT');
    cpu.runToCompletion();
    expect(cpu.bubbles).toBe(0);
    expect(cpu.regs[3]).toBe(0);
  });

  it('forwards a loaded value straight into a store with no stall', () => {
    const cpu = build('ADDI R1, R0, 50\nSW R1, 0(R0)\nLW R2, 0(R0)\nSW R2, 4(R0)\nHALT');
    cpu.runToCompletion();
    expect(cpu.bubbles).toBe(0);
    expect(cpu.mem.get(4)).toBe(50);
  });

  it('forwards through a chain of dependent instructions', () => {
    const cpu = build('ADDI R1, R0, 2\nADD R2, R1, R1\nADD R3, R2, R2\nADD R4, R3, R3\nHALT');
    cpu.runToCompletion();
    expect([cpu.regs[1], cpu.regs[2], cpu.regs[3], cpu.regs[4]]).toEqual([2, 4, 8, 16]);
    expect(cpu.bubbles).toBe(0);
  });
});

describe('data hazards without forwarding', () => {
  it('stalls twice when the producer is one slot ahead', () => {
    const cpu = build('ADDI R1, R0, 5\nADD R2, R1, R1\nHALT', false);
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(10);
    expect(cpu.bubbles).toBe(2);
    expect(cpu.cycles).toBe(9);
  });

  it('stalls once when the producer is two slots ahead', () => {
    const cpu = build('ADDI R1, R0, 5\nNOP\nADD R2, R1, R1\nHALT', false);
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(10);
    expect(cpu.bubbles).toBe(1);
  });

  it('needs no stall when the producer is three slots ahead', () => {
    const cpu = build('ADDI R1, R0, 5\nNOP\nNOP\nADD R2, R1, R1\nHALT', false);
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(10);
    expect(cpu.bubbles).toBe(0);
  });

  it('is slower than forwarding for the same program', () => {
    const src = 'ADDI R1, R0, 5\nADD R2, R1, R1\nADD R3, R2, R2\nHALT';
    const withFwd = build(src, true);
    const withoutFwd = build(src, false);
    withFwd.runToCompletion();
    withoutFwd.runToCompletion();
    expect(withoutFwd.cycles).toBeGreaterThan(withFwd.cycles);
    // both must compute identical results in the end
    expect(withoutFwd.regs).toEqual(withFwd.regs);
  });
});

// -- branches ------------------------------------------------------------------------

describe('branches', () => {
  it('flushes two younger slots when a branch is taken', () => {
    const cpu = build('BEQ R0, R0, target\nADDI R1, R0, 5\nADDI R2, R0, 6\ntarget: HALT');
    cpu.runToCompletion();
    expect(cpu.regs[1]).toBe(0);
    expect(cpu.regs[2]).toBe(0);
    expect(cpu.flushEvents).toBe(1);
    expect(cpu.squashed).toBe(2);
    expect(cpu.retired).toBe(2); // the branch and the HALT
    expect(cpu.done).toBe(true);
  });

  it('loses nothing when a branch is not taken', () => {
    const cpu = build('ADDI R1, R0, 5\nBEQ R1, R0, target\nADDI R2, R0, 6\ntarget: HALT');
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(6);
    expect(cpu.flushEvents).toBe(0);
    expect(cpu.squashed).toBe(0);
  });

  it('compares forwarded values, not stale register file reads', () => {
    // R1 is written by the instruction right before the branch; the branch
    // must see the new value in Execute via forwarding
    const cpu = build('ADDI R1, R0, 1\nBEQ R1, R0, wrong\nADDI R2, R0, 42\nJMP done\nwrong: ADDI R2, R0, 99\ndone: HALT');
    cpu.runToCompletion();
    expect(cpu.regs[2]).toBe(42);
  });

  it('keeps looping when a HALT was fetched speculatively before the branch resolved', () => {
    // the HALT sits right after the branch, so Fetch grabs it before the
    // first branch resolution; the taken branch must re-arm fetching
    const cpu = build(`
      ADDI R1, R0, 0
      ADDI R2, R0, 3
loop:
      ADDI R1, R1, 1
      ADDI R2, R2, -1
      BNE R2, R0, loop
      HALT
    `);
    cpu.runToCompletion();
    expect(cpu.regs[1]).toBe(3);
    expect(cpu.regs[2]).toBe(0);
    expect(cpu.flushEvents).toBe(2);
    expect(cpu.done).toBe(true);
    expect(cpu.retired).toBe(12); // 2 setup + 3x(2 body + 1 branch) + 1 HALT
  });

  it('runs a countdown loop to the end with correct bookkeeping', () => {
    const cpu = build(`
      ADDI R1, R0, 0
      ADDI R2, R0, 5
loop:
      ADD R1, R1, R2
      ADDI R2, R2, -1
      BNE R2, R0, loop
      SW R1, 300(R0)
      HALT
    `);
    cpu.runToCompletion();
    expect(cpu.regs[1]).toBe(15); // 5 + 4 + 3 + 2 + 1
    expect(cpu.regs[2]).toBe(0);
    expect(cpu.mem.get(300)).toBe(15);
    expect(cpu.flushEvents).toBe(4); // taken four times, falls through the fifth
    expect(cpu.bubbles).toBe(0);
    expect(cpu.done).toBe(true);
    const cpi = cpu.cycles / cpu.retired;
    expect(cpi).toBeGreaterThan(1);
  });
});

// -- memory ------------------------------------------------------------------------------

describe('memory', () => {
  it('round-trips a value through memory', () => {
    const cpu = build('ADDI R1, R0, 77\nSW R1, 8(R0)\nLW R2, 8(R0)\nHALT');
    cpu.runToCompletion();
    expect(cpu.mem.get(8)).toBe(77);
    expect(cpu.regs[2]).toBe(77);
  });

  it('reads zero from memory that was never written', () => {
    const cpu = build('LW R1, 500(R0)\nHALT');
    cpu.runToCompletion();
    expect(cpu.regs[1]).toBe(0);
  });

  it('adds the base register and offset for the address', () => {
    const cpu = build('ADDI R1, R0, 200\nADDI R2, R0, 9\nSW R2, 12(R1)\nLW R3, 212(R0)\nHALT');
    cpu.runToCompletion();
    expect(cpu.mem.get(212)).toBe(9);
    expect(cpu.regs[3]).toBe(9);
  });
});

// -- determinism ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical state for identical runs', () => {
    const src = `
      ADDI R1, R0, 3
loop:
      LW R2, 0(R0)
      ADD R1, R1, R2
      SW R1, 4(R0)
      ADDI R2, R2, 1
      ADDI R3, R0, 3
      BNE R3, R2, loop
      HALT
    `;
    const a = build(src);
    const b = build(src);
    a.runToCompletion();
    b.runToCompletion();
    expect(a.regs).toEqual(b.regs);
    expect([...a.mem.entries()]).toEqual([...b.mem.entries()]);
    expect(a.cycles).toBe(b.cycles);
    expect(a.retired).toBe(b.retired);
    expect(a.bubbles).toBe(b.bubbles);
    expect(a.forwards).toBe(b.forwards);
  });

  it('exposes a cycle snapshot with five stage cells per step', () => {
    const cpu = build('ADDI R1, R0, 1\nHALT');
    const snap = cpu.step();
    expect(snap.cycle).toBe(1);
    expect(snap.cells).toHaveLength(5);
    expect(snap.cells[0].text).toContain('ADDI');
    expect(snap.cells[0].kind).toBe('normal');
  });
});
