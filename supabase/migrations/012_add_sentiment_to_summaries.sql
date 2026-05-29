alter table public.conversation_summaries 
add column if not exists customer_sentiment text,
add column if not exists issue_complexity text;
