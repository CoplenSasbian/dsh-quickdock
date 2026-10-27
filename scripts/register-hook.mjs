import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./schemastery-hook.mjs', pathToFileURL(import.meta.filename))
