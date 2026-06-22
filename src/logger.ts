import chalk from "chalk";

export const logger = {
  success: (msg: string) => console.log(chalk.green("✓"), msg),
  error: (msg: string) => console.error(chalk.red("✗"), msg),
  warn: (msg: string) => console.warn(chalk.yellow("!"), msg),
  info: (msg: string) => console.log(chalk.blue("ℹ"), msg),
  debug: (msg: string) => {
    if (process.env.DEBUG) console.log(chalk.gray(msg));
  },
};
