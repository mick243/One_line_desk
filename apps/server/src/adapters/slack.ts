import type { AdapterCapabilities, MessengerAdapter } from './types';

// 실제 Slack DM(10/26, ADR-17). SLACK_BOT_TOKEN이 있을 때만 써요. 봇 권한: users:read.email · im:write · chat:write.
// 받는 사람은 회사 메일로 찾고(users.lookupByEmail), 봇과의 DM을 열어(conversations.open) 글 하나를 보내요(chat.postMessage).
// 보내기 전에 Slack 보관 기간·보안팀 확인이 먼저예요(ADR-16·17). 토큰은 환경 변수에만 두고 DB·로그에 남기지 않아요.

interface SlackReply {
  ok: boolean;
  error?: string;
  user?: { id: string };
  channel?: { id: string };
}

export class SlackMessenger implements MessengerAdapter {
  readonly capabilities: AdapterCapabilities = { name: 'slack', label: 'Slack', mock: false };

  constructor(
    private readonly token: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async call(method: string, params: Record<string, string>): Promise<SlackReply> {
    const res = await this.http(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: new URLSearchParams(params),
    });
    if (!res.ok) throw new Error(`Slack ${method} 실패(${res.status})`);
    return (await res.json()) as SlackReply;
  }

  async sendDirect(m: { toEmail: string; text: string }): Promise<'sent' | 'not-found'> {
    const found = await this.call('users.lookupByEmail', { email: m.toEmail });
    if (!found.ok) {
      if (found.error === 'users_not_found') return 'not-found';
      throw new Error(`Slack users.lookupByEmail: ${found.error}`);
    }
    const im = await this.call('conversations.open', { users: found.user!.id });
    if (!im.ok || !im.channel) throw new Error(`Slack conversations.open: ${im.error}`);
    const sent = await this.call('chat.postMessage', { channel: im.channel.id, text: m.text, unfurl_links: 'false', unfurl_media: 'false' });
    if (!sent.ok) throw new Error(`Slack chat.postMessage: ${sent.error}`);
    return 'sent';
  }
}
