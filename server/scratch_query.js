import 'dotenv/config';
import axios from 'axios';

async function main() {
  const base = 'https://helpdesk.soymomo.io';
  const token = 'bCqXQA413HdyyPn29mFw3Yvq';
  const accountId = '1';
  const internalId = '11117'; // ID interno de la conversación

  console.log(`Querying Chatwoot details for internal ID ${internalId}...`);

  const client = axios.create({
    baseURL: base,
    headers: {
      api_access_token: token,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  try {
    console.log(`Testing POST to /summary for conversation ${internalId}...`);
    try {
      const { data: summaryData } = await client.post(`/api/v1/accounts/${accountId}/conversations/${internalId}/summary`);
      console.log('POST SUMMARY RESPONSE:', JSON.stringify(summaryData, null, 2));
    } catch (e) {
      console.log('POST SUMMARY ERROR:', e.response?.status, JSON.stringify(e.response?.data, null, 2));
    }
  } catch (error) {
    console.error('General Error:', error.message);
  }
}

main().catch(console.error);
