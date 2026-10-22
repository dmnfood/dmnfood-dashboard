'use strict';
const { APP_ORIGIN } = require('./naverworks-core.cjs');
const { createHandler: createAiHandler } = require('./order-ai-service.cjs');
const { createHandler: createTextHandler } = require('./order-text-source-service.cjs');

// Keep the public intake API separate while sharing one deployed function entry.
function createHandler({ statusHandler = createAiHandler('status'), textSourceHandler = createTextHandler() } = {}) {
    return async (request, response) => {
        const url = new URL(request.url, APP_ORIGIN), urlResources = url.searchParams.getAll('resource');
        const frameworkResource = request.query?.resource;
        const frameworkResources = frameworkResource === undefined ? [] : Array.isArray(frameworkResource) ? frameworkResource : [frameworkResource];
        const resources = urlResources.length ? urlResources : frameworkResources;
        if (!url.searchParams.has('resource') && frameworkResource === undefined) return statusHandler(request, response);
        if (resources.length !== 1 || resources[0] !== 'text-sources'
            || frameworkResources.length && (frameworkResources.length !== 1 || frameworkResources[0] !== 'text-sources')) {
            response.statusCode = 400; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
            return response.end(JSON.stringify({ ok: false, code: 'resource_invalid', message: '발주 원문 요청을 확인해 주세요.' }));
        }
        url.searchParams.delete('resource');
        const query = { ...request.query }; delete query.resource;
        return textSourceHandler({ ...request, method: request.method, headers: request.headers, body: request.body, url: `${url.pathname}${url.search}`, query }, response);
    };
}
module.exports = { createHandler };
