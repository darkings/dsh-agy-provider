#!/usr/bin/env node
import { runDoctorCli } from '../lib/doctor.js'

const exitCode = await runDoctorCli(process.argv.slice(2))
process.exit(exitCode)
