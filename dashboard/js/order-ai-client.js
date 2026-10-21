export async function requestOrderAi(session, path, { body, signal } = {}) {
  if (navigator.onLine === false) throw new Error('인터넷 연결 후 다시 시도해 주세요.');
  const token = await session.user.getIdToken();
  const response = await fetch(`/api/order-ai/${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin', signal,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    const error = new Error(data.message || (response.status === 401 ? '다시 로그인한 뒤 시도해 주세요.' : '연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'));
    error.status = response.status; error.code = data.code; throw error;
  }
  return data;
}
