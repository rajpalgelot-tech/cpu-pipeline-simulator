// A tiny MIPS-flavored assembly language and assembler. Eight registers
// (R0 is hardwired to zero), word-addressed data memory, labels for branches.

export type Op =
  | 'ADD' | 'SUB' | 'AND' | 'OR' | 'XOR'
  | 'ADDI'
  | 'LW' | 'SW'
  | 'BEQ' | 'BNE' | 'JMP'
  | 'NOP' | 'HALT';

export interface Instruction {
  op: Op;
  rd: number | null; // destination register, null for SW/branches/JMP/NOP/HALT
  rs1: number | null; // first source (base register for LW/SW)
  rs2: number | null; // second source (store value for SW)
  imm: number | null; // ADDI immediate, LW/SW offset, branch target index for BEQ/BNE/JMP
  line: number; // 1-based source line, for error messages
  text: string; // original text, for the pipeline diagram
}

export type AssembleResult =
  | { ok: true; program: Instruction[] }
  | { ok: false; errors: string[] };

const R_TYPES = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR']);

function parseReg(token: string): number | null {
  const m = /^R([0-7])$/i.exec(token.trim());
  return m ? Number(m[1]) : null;
}

function parseImm(token: string): number | null {
  if (/^-?\d+$/.test(token.trim())) return Number(token.trim());
  return null;
}

// Parses "offset(reg)" or "reg" (offset defaults to 0), used by LW and SW.
function parseMemOperand(token: string): { reg: number; offset: number } | null {
  const m = /^\s*(-?\d+)?\s*\(\s*(R[0-7])\s*\)\s*$/i.exec(token);
  if (m) return { reg: parseReg(m[2])!, offset: m[1] ? Number(m[1]) : 0 };
  const bare = parseReg(token);
  if (bare !== null) return { reg: bare, offset: 0 };
  return null;
}

export function assemble(source: string): AssembleResult {
  const errors: string[] = [];
  const labels = new Map<string, number>();
  const pending: { instr: Instruction; labelTarget?: string }[] = [];
  const program: Instruction[] = [];

  const lines = source.split('\n');
  lines.forEach((raw, i) => {
    const line = i + 1;
    let rest = raw.replace(/#.*$/, '').trim();
    // peel off any leading labels, e.g. "loop: ADD R1, R2, R3"
    for (;;) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rest);
      if (!m) break;
      if (labels.has(m[1])) errors.push(`line ${line}: label "${m[1]}" is defined twice`);
      labels.set(m[1], program.length);
      rest = m[2].trim();
    }
    if (rest === '') return;

    const parts = rest.split(/\s+/);
    const mnemonic = parts[0].toUpperCase();
    const operands = rest.slice(parts[0].length).split(',').map((s) => s.trim()).filter(Boolean);
    const text = rest;

    const push = (instr: Instruction, labelTarget?: string) => {
      pending.push({ instr, labelTarget });
      program.push(instr);
    };

    if (R_TYPES.has(mnemonic)) {
      if (operands.length !== 3) { errors.push(`line ${line}: ${mnemonic} needs three registers`); return; }
      const rd = parseReg(operands[0]);
      const rs1 = parseReg(operands[1]);
      const rs2 = parseReg(operands[2]);
      if (rd === null || rs1 === null || rs2 === null) {
        errors.push(`line ${line}: ${mnemonic} needs registers R0 through R7`);
        return;
      }
      push({ op: mnemonic as Op, rd, rs1, rs2, imm: null, line, text });
    } else if (mnemonic === 'ADDI') {
      if (operands.length !== 3) { errors.push(`line ${line}: ADDI needs a register, a register, and a number`); return; }
      const rd = parseReg(operands[0]);
      const rs1 = parseReg(operands[1]);
      const imm = parseImm(operands[2]);
      if (rd === null || rs1 === null || imm === null) {
        errors.push(`line ${line}: ADDI looks like "ADDI R1, R2, -5"`);
        return;
      }
      push({ op: 'ADDI', rd, rs1, rs2: null, imm, line, text });
    } else if (mnemonic === 'LW' || mnemonic === 'SW') {
      if (operands.length !== 2) { errors.push(`line ${line}: ${mnemonic} looks like "${mnemonic} R2, 0(R4)"`); return; }
      const mem = parseMemOperand(operands[1]);
      if (mem === null) {
        errors.push(`line ${line}: ${mnemonic} memory operand looks like "0(R4)" or "12(R4)"`);
        return;
      }
      if (mnemonic === 'LW') {
        const rd = parseReg(operands[0]);
        if (rd === null) { errors.push(`line ${line}: LW needs a destination register`); return; }
        push({ op: 'LW', rd, rs1: mem.reg, rs2: null, imm: mem.offset, line, text });
      } else {
        const rs2 = parseReg(operands[0]);
        if (rs2 === null) { errors.push(`line ${line}: SW needs a source register to store`); return; }
        push({ op: 'SW', rd: null, rs1: mem.reg, rs2, imm: mem.offset, line, text });
      }
    } else if (mnemonic === 'BEQ' || mnemonic === 'BNE') {
      if (operands.length !== 3) { errors.push(`line ${line}: ${mnemonic} looks like "${mnemonic} R1, R2, label"`); return; }
      const rs1 = parseReg(operands[0]);
      const rs2 = parseReg(operands[1]);
      if (rs1 === null || rs2 === null) {
        errors.push(`line ${line}: ${mnemonic} needs two registers to compare`);
        return;
      }
      push({ op: mnemonic as Op, rd: null, rs1, rs2, imm: null, line, text }, operands[2]);
    } else if (mnemonic === 'JMP') {
      if (operands.length !== 1) { errors.push(`line ${line}: JMP looks like "JMP end"`); return; }
      push({ op: 'JMP', rd: null, rs1: null, rs2: null, imm: null, line, text }, operands[0]);
    } else if (mnemonic === 'NOP') {
      push({ op: 'NOP', rd: null, rs1: null, rs2: null, imm: null, line, text });
    } else if (mnemonic === 'HALT') {
      push({ op: 'HALT', rd: null, rs1: null, rs2: null, imm: null, line, text });
    } else {
      errors.push(`line ${line}: unknown instruction "${parts[0]}"`);
    }
  });

  // second pass: resolve branch and jump targets to instruction indexes
  for (const { instr, labelTarget } of pending) {
    if (labelTarget === undefined) continue;
    const target = labels.get(labelTarget!);
    if (target === undefined) {
      errors.push(`line ${instr.line}: unknown label "${labelTarget}"`);
    } else {
      instr.imm = target;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, program };
}
