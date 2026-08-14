// The signal toggles behind the Breakpoints panel's exception section. The interesting failure here
// is a command that is well-formed and means the opposite of what was asked, which running a real
// gdb would not make obvious — it would simply not stop, exactly as an unchecked box should not.
import * as assert from 'assert';
import { defaultEnabledSignals, signalHandlingCommand, signalHandlingCommands, SIGNAL_FILTERS } from '../src/signalFilters';

describe('signal filters', () => {
  describe('the declared filters', () => {
    it('covers the faults an assembly program actually hits', () => {
      const names = SIGNAL_FILTERS.map((f) => f.filter);
      for (const signal of ['SIGSEGV', 'SIGILL', 'SIGFPE', 'SIGBUS', 'SIGABRT']) {
        assert.ok(names.includes(signal), `${signal} is not offered`);
      }
    });

    // SIGINT is how VS Code's Pause button reaches the program; handing the user a checkbox that
    // turns off their own pause button would be a trap rather than a feature. SIGTRAP is how every
    // breakpoint arrives.
    it('offers nothing the debugger itself depends on', () => {
      const names = SIGNAL_FILTERS.map((f) => f.filter);
      for (const signal of ['SIGINT', 'SIGTRAP']) {
        assert.ok(!names.includes(signal), `${signal} is offered, but the debugger needs it`);
      }
    });

    it('names and describes every one, since the label and tooltip are the whole UI', () => {
      for (const filter of SIGNAL_FILTERS) {
        assert.ok(filter.label.trim().length > 0, `${filter.filter} has no label`);
        assert.ok(filter.description.trim().length > 0, `${filter.filter} has no description`);
        // The panel shows the label alone; a bare "SIGBUS" says nothing to someone who would
        // benefit from the toggle, and the raw name still belongs there for someone who knows it.
        assert.ok(filter.label.includes(filter.filter), `${filter.filter}'s label does not name the signal`);
        assert.notStrictEqual(filter.label, filter.filter, `${filter.filter}'s label adds nothing to the raw name`);
      }
    });

    it('has no duplicate filter ids, which DAP keys the checkboxes on', () => {
      const names = SIGNAL_FILTERS.map((f) => f.filter);
      assert.strictEqual(new Set(names).size, names.length);
    });

    // gdb reports Stop=Yes for every one of these out of the box. A box that started unchecked
    // would describe a session other than the one actually running.
    it('starts every box checked, matching what gdb does before anyone asks', () => {
      for (const filter of SIGNAL_FILTERS) {
        assert.strictEqual(filter.default, true, `${filter.filter} does not default to stopping`);
      }
      assert.strictEqual(defaultEnabledSignals().size, SIGNAL_FILTERS.length);
    });
  });

  describe('the commands they turn into', () => {
    it('stops and prints when checked', () => {
      assert.strictEqual(signalHandlingCommand('SIGSEGV', true), 'handle SIGSEGV stop print pass');
    });

    it('stays silent when unchecked', () => {
      assert.strictEqual(signalHandlingCommand('SIGSEGV', false), 'handle SIGSEGV nostop noprint pass');
    });

    // The one thing that must never change with the checkbox. "Do not interrupt me for this" is a
    // statement about the debugger; withholding the signal from the program would make it behave
    // differently under the debugger than outside it.
    it('passes the signal to the program either way', () => {
      for (const stop of [true, false]) {
        const command = signalHandlingCommand('SIGSEGV', stop);
        assert.ok(/(^| )pass$/.test(command), `${command} does not pass the signal on`);
        assert.ok(!command.includes('nopass'), `${command} withholds the signal from the program`);
      }
    });

    // DAP hands over the complete desired set, so a signal that has dropped out of it since the
    // last call has to be actively turned off — leaving it alone would strand it at "stop".
    it('emits one command per known signal, not just for the enabled ones', () => {
      const commands = signalHandlingCommands(new Set(['SIGSEGV']));
      assert.strictEqual(commands.length, SIGNAL_FILTERS.length);
      assert.ok(commands.some((c) => c === 'handle SIGSEGV stop print pass'));
      for (const filter of SIGNAL_FILTERS.filter((f) => f.filter !== 'SIGSEGV')) {
        assert.ok(
          commands.includes(`handle ${filter.filter} nostop noprint pass`),
          `${filter.filter} was left at whatever it was, rather than turned off`,
        );
      }
    });

    it('turns everything off for an empty set', () => {
      for (const command of signalHandlingCommands(new Set())) {
        assert.match(command, /nostop noprint pass$/);
      }
    });

    // These are interpolated into an -interpreter-exec console "..." string, which splits on
    // whitespace and would be broken by a quote or a backslash in the signal name.
    it('produces commands that are safe to embed in an MI console command', () => {
      for (const command of signalHandlingCommands(defaultEnabledSignals())) {
        assert.ok(!/["\\]/.test(command), `${command} would need escaping`);
      }
    });
  });
});
