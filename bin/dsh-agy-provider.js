#!/usr/bin/env node
import { runDoctorCli } from '../lib/doctor.js'
import { runAgentsCli } from '../lib/agents-cli.js'

const argv = process.argv.slice(2)
const exitCode = argv[0] === 'agent' || argv[0] === 'agents'
  ? await runAgentsCli(argv)
  : await runDoctorCli(argv)
process.exit(exitCode)
