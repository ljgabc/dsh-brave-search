// One-off test harness for dsh-brave-search: maps the bare @deepseek-ai/*
// imports to the dsh installation copies, so index.js can be imported outside
// the Host.
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
