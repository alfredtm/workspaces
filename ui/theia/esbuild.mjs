/**
 * Theia's esbuild driver (generated once by `theia build`, then ours to edit).
 *
 * Watch mode builds the BROWSER bundle only. The node pass re-copies the native
 * modules (lib/prebuilds/<platform>/pty.node, lib/backend/native/*.node) in place
 * on every rebuild; the running backend has those files mmapped and loads some
 * of them lazily (node-pty on the first terminal), so a rewrite under it ends in
 * a SIGSEGV as soon as a browser connects. Backend changes need a full build +
 * restart anyway, which is what the lab does on `docker restart`.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';

import esbuild from 'esbuild';

const browserContext = await esbuild.context(browserOptions);

if (watch) {
    await browserContext.watch();
} else {
    const nodeContext = await esbuild.context(nodeOptions);
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
    } catch {
        process.exit(1);
    }
}
