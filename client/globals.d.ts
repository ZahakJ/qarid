/**
 * Build-time constants vite substitutes (`define` in vite.config.ts).
 *
 * `__APP_VERSION__` is package.json's `version`, read at config load, so the
 * «عن قريض» row in #/more cannot drift from the released package the way a
 * second copy of the number in a TS file would.
 */
declare const __APP_VERSION__: string
