#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const env = { ...process.env, CUTE_ISLAND_CLI: '1' }
const bundled = path.join(__dirname, '../out/cli.cjs')
if (fs.existsSync(bundled)) {
  process.env.CUTE_ISLAND_CLI = '1'
  require(bundled)
} else {
  const tsxCli = path.join(__dirname, '../node_modules/tsx/dist/cli.mjs')
  const result = spawnSync(process.execPath, [tsxCli, path.join(__dirname, '../src/cli.ts'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env
  })
  process.exit(result.status ?? 1)
}
