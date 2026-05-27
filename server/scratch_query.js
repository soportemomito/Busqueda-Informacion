import 'dotenv/config';
import axios from 'axios';

async function main() {
  const base = 'https://helpdesk.soymomo.io';
  const token = 'bCqXQA413HdyyPn29mFw3Yvq';
  const accountId = '1';
  const internalId = '11117'; // ID interno de la conversación

  console.log(`Querying Chatwoot messages with full details including attachments for internal ID ${internalId}...`);

  const client = axios.create({
    baseURL: base,
    headers: {
      api_access_token: token,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  try {
    const { data: msgData } = await client.get(`/api/v1/accounts/${accountId}/conversations/${internalId}/messages`);
    const messages = msgData?.payload || msgData;

    console.log(`Found ${messages?.length ?? 0} messages.`);
    for (const m of messages || []) {
      console.log(`\n----------------------------------------------------`);
      console.log(`Msg ID: ${m.id} | Type: ${m.message_type} | Sender: ${m.sender?.name || m.sender_type}`);
      console.log(`Content: ${JSON.stringify(m.content)}`);
      
      if (m.attachments && m.attachments.length > 0) {
        console.log('ATTACHMENTS FOUND:', JSON.stringify(m.attachments, null, 2));
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

main().catch(console.error);
