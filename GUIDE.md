# Pipeline Guide

A short guide to [Pipeline](https://rajpalgelot-tech.github.io/cpu-pipeline-simulator/), a five-stage CPU you can watch chase hazards. No computer architecture background needed; if you can read "R1 = R2 + R3", you can run every experiment here.

## Why is this useful?

Every app you use runs on a pipelined CPU, and pipelining is the reason your processor is fast. The idea is simple enough to say in one sentence: while one instruction is being executed, the next one is being decoded, and the one after that is being fetched, like an assembly line for arithmetic. The complications (hazards) are where the real learning lives, and they only make sense when you can watch one happen. That is what this simulator is for. If you are a student, being able to explain forwarding, load-use stalls, and branch flushes from something you personally watched is a genuinely good interview moment.

## What is a pipeline, in really simple words?

Imagine a car wash with five stations: rinse, soap, scrub, rinse again, dry. One car per station at a time. While one car is being scrubbed, the next is getting soapy, and a third is being rinsed. Even though each car takes five stations' worth of time, a finished car rolls out every single minute. That throughput is why pipelining won.

1. **The five stations.** Fetch grabs the next instruction from the program. Decode figures out what it needs. Execute does the math. Memory touches data. Writeback writes the result into a register.
2. **The assembly line jams.** If an instruction needs a result that has not been written back yet (a data hazard), the line has to wait. Forwarding is a shortcut pipe that hands a result straight from one station to the next before it officially exists. Most jams disappear with good forwarding, but one jam is unavoidable: a value loaded from memory is simply not ready until the Memory station, so the instruction right behind it must wait one cycle (the load-use hazard).
3. **Wrong turns are expensive.** When a branch turns out to jump somewhere else, the two instructions behind it in the line were fetched on a wrong guess. They get thrown out (flushed) and the line refills from the right place. That is the two cycle branch penalty you can watch in red.

## Quick start

Open [the demo](https://rajpalgelot-tech.github.io/cpu-pipeline-simulator/). A Fibonacci program is already loaded. Press **Step** a few times and watch instructions slide rightward, one station per row. Then press **Run** and let it finish; the banner reports the cycle count and CPI (cycles per instruction, the efficiency score).

## The buttons

| Control | What it does |
| --- | --- |
| Assemble & load | Compiles the editor text into machine instructions |
| Step | One cycle, one new row in the diagram |
| Run / Pause | Steps automatically at the slider's speed |
| Reset | Empties the pipe and starts the program over |
| Forwarding checkbox | The bypass pipes; uncheck it to feel what the hardware is worth |
| Examples | Fibonacci, the load-use demo, and a store-then-sum program |

## Three experiments

1. **The bypass tax.** Run Fibonacci with forwarding on and note the cycles. Uncheck forwarding, Reset, run again. The gap is exactly what forwarding hardware buys you, and the "forwards" total shows how many values it rescued.
2. **The bubble that cannot be forwarded away.** Load the "Load-use demo" and step to cycle 5. A red bubble sits in Execute while the stalled instruction waits in Decode. No forwarding setting can remove it; the value literally does not exist yet.
3. **The wrong-guess cleanup.** Watch any loop run. Each time the branch jumps back, the diagram shows instructions struck through in red: those were fetched on the assumption the loop had ended. They never retire.

## Reading the diagram

- Each row is one cycle; each column is a stage. An instruction travels one column to the right per row.
- A red **bubble** is a wasted slot created by a stall.
- A struck-through red cell is an instruction killed by a taken branch.
- An amber pulsing cell is an instruction being held in Decode waiting for its operands.
- The rightmost column (WB) is where a result officially lands; the totals row counts it as retired.

## Questions people ask

**What is CPI and why is it above 1?** Cycles per instruction. A perfect infinite pipeline would be 1.0: one instruction finishing every cycle. Stalls and flushes push it up. Fibonacci lands near 1.25 with forwarding.

**Why does the branch cost two cycles?** Because the branch only decides in Execute, and by then two younger instructions have already been fetched on the wrong assumption.

**Why can't forwarding fix the load-use hazard?** The loaded value only exists after the Memory stage. The instruction right behind the load needs it in Execute, one stage too early. One bubble is the minimum, and this is exactly why real compilers reorder code to keep a gap after loads.

**Why is R0 always zero?** It is a classic trick from real RISC designs: having a register that reads as zero lets you encode common operations (copy, clear, compare against zero) with ordinary instructions.

**Can I write my own program?** Yes, type it in the editor and press Assemble & load. Labels end with a colon, comments start with #, and errors come back with line numbers.
