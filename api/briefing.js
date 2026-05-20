const OPENAI_MODEL = 'gpt-4.1-mini';

const systemPrompt = [
  '너는 한국 제조/식품 회사의 운영 계획 비서다.',
  '목표는 거창한 전략 보고서가 아니라 오늘 실행에 바로 도움이 되는 운영 브리핑이다.',
  '업무 우선순위, 지연, 병목, 의존관계, 임박 기한을 기준으로 판단한다.',
  '한국어로 간결하고 실무적인 말투를 사용한다.',
  '출력은 다음 섹션만 사용한다: 오늘 가장 중요한 업무, 병목 업무, 지연 위험, 추천 행동.',
  '각 섹션은 2~4개의 짧은 bullet로 작성한다.',
  '근거가 부족하면 추측하지 말고 확인 필요라고 적는다.',
].join('\n');

const sendJson = (response, statusCode, payload) => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
};

const readBody = (request) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 220000) {
      reject(new Error('요청 데이터가 너무 큽니다.'));
      request.destroy();
    }
  });
  request.on('end', () => resolve(body));
  request.on('error', reject);
});

module.exports = async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'POST 요청만 지원합니다.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(response, 500, {
      error: 'OPENAI_API_KEY 환경 변수가 설정되지 않았습니다.',
      setup: 'Vercel Dashboard > Project > Settings > Environment Variables에서 OPENAI_API_KEY를 추가하세요.',
    });
  }

  let briefingPayload;
  try {
    const rawBody = await readBody(request);
    const parsed = JSON.parse(rawBody || '{}');
    briefingPayload = parsed.briefingPayload;
  } catch (error) {
    return sendJson(response, 400, { error: '요청 본문을 읽지 못했습니다.' });
  }

  if (!briefingPayload || typeof briefingPayload !== 'object') {
    return sendJson(response, 400, { error: '브리핑 데이터가 없습니다.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: '다음 Planning Assistant 업무 데이터를 바탕으로 오늘의 운영 브리핑을 작성해 주세요.\n\n' + JSON.stringify(briefingPayload),
          },
        ],
      }),
    });

    clearTimeout(timeout);

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      return sendJson(response, openaiResponse.status >= 500 ? 502 : 400, {
        error: 'OpenAI API 요청에 실패했습니다.',
        detail: errorText.slice(0, 500),
      });
    }

    const data = await openaiResponse.json();
    const briefing = data.choices?.[0]?.message?.content?.trim();
    if (!briefing) {
      return sendJson(response, 502, { error: 'OpenAI 응답에 브리핑 내용이 없습니다.' });
    }

    return sendJson(response, 200, { briefing });
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      return sendJson(response, 504, { error: 'AI 브리핑 요청 시간이 초과되었습니다.' });
    }
    return sendJson(response, 500, { error: 'AI 브리핑 생성 중 오류가 발생했습니다.' });
  }
};
