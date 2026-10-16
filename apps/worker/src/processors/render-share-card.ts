import type { JobLike } from './deps.js';
import type { RenderShareCardJob } from '../queues.js';
import { runIdempotentHandler } from './handler.js';
import type { ProcessorDepsEx } from './extended-deps.js';

export async function processRenderShareCardJob(
  job: JobLike<RenderShareCardJob>,
  deps: ProcessorDepsEx,
): Promise<void> {
  await runIdempotentHandler({
    queue: 'render-share-card',
    job,
    deps,
    work: async (ctx) => {
      const { subjectId, versionNumber } = job.data;
      const cardKey = `share-cards/${subjectId}/v${versionNumber}.svg`;

      // Idempotency: check if card already exists
      const existing = await deps.storage.headObject(cardKey);
      if (existing) {
        ctx.log.info('Share card already rendered', { cardKey });
        return;
      }

      // Render minimal SVG placeholder
      // Note: The real card renderer (frontend lane asset) replaces this SVG placeholder
      // with a fully-rendered card including metadata, images, and styling.
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#f0f0f0"/>
  <text x="600" y="300" font-size="48" text-anchor="middle" fill="#333">
    ${escapeXml(subjectId)}
  </text>
  <text x="600" y="360" font-size="32" text-anchor="middle" fill="#666">
    Version ${versionNumber}
  </text>
</svg>`;

      const bytes = new TextEncoder().encode(svgContent);
      await deps.storage.putObject(cardKey, bytes, 'image/svg+xml');

      ctx.log.info('Share card rendered', { cardKey });
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
