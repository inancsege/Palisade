import { Command } from 'commander';
import { serveCommand } from './commands/serve.js';
import { scanCommand } from './commands/scan.js';
import { auditCommand } from './commands/audit.js';
import { reportCommand } from './commands/report.js';

const program = new Command()
  .name('palisade')
  .description('Runtime prompt injection detection and behavioral sandboxing for AI agents')
  .version('0.1.0');

program.addCommand(serveCommand);
program.addCommand(scanCommand);
program.addCommand(auditCommand);
program.addCommand(reportCommand);

program.parse();
