from datetime import datetime


# Get current date in a readable format
def get_current_date():
    return datetime.now().strftime("%B %d, %Y")


query_writer_instructions = """Your goal is to generate sophisticated and divers
e web search queries. These queries are intended for an advanced automated web r
esearch tool capable of analyzing complex results, following links, and synthesi
zing information.

Instructions:
- Always prefer a single search query, only add another query if the original qu
estion requests multiple aspects or elements and one query is not enough.
- Each query should focus on one specific aspect of the original question.
- Don't produce more than {number_queries} queries.
- Queries should be diverse, if the topic is broad, generate more than 1 query.
- Don't generate multiple similar queries, 1 is enough.
- Query should ensure that the most current information is gathered. The current
 date is {current_date}.

Format:
- Format your response as a JSON object with ALL three of these exact keys:
   - "rationale": Brief explanation of why these queries are relevant
   - "query": A list of search queries

Example:

Topic: What revenue grew more last year apple stock or the number of people buyi
ng an iphone
```json
{{{{
    "rationale": "To answer this comparative growth question accurately, we need
 specific data points on Apple's stock performance and iPhone sales metrics. The
se queries target the precise financial information needed: company revenue tren
ds, product-specific unit sales figures, and stock price movement over the same
fiscal period for direct comparison.",
    "query": ["Apple total revenue growth fiscal year 2024", "iPhone unit sales
growth fiscal year 2024", "Apple stock price growth fiscal year 2024"],
}}}}
```

Context: {{research_topic}}"""


web_searcher_instructions = """Conduct targeted Google Searches to gather the mo
st recent, credible information on "{{research_topic}}" and synthesize it into a v
erifiable text artifact.

Instructions:
- Query should ensure that the most current information is gathered. The current
 date is {{current_date}}.
- Conduct multiple, diverse searches to gather comprehensive information.
- Consolidate key findings while meticulously tracking the source(s) for each sp
ecific piece of information.
- The output should be a well-written summary or report based on your search fin
dings.
- Only include the information found in the search results, don't make up any in
formation.

Research Topic:
{{research_topic}}
"""

reflection_instructions = """You are an expert research assistant analyzing summ
aries about "{{research_topic}}".

Instructions:
- Identify knowledge gaps or areas that need deeper exploration and generate a f
ollow-up query. (1 or multiple).
- If provided summaries are sufficient to answer the user's question, don't gene
rate a follow-up query.
- If there is a knowledge gap, generate a follow-up query that would help expand
 your understanding.
- Focus on technical details, implementation specifics, or emerging trends that
weren't fully covered.

Requirements:
- Ensure the follow-up query is self-contained and includes necessary context fo
r web search.

Output Format:
- Format your response as a JSON object with these exact keys:
   - "is_sufficient": true or false
   - "knowledge_gap": Describe what information is missing or needs clarificatio
n
   - "follow_up_queries": Write a specific question to address this gap

Example:
```json
{{{{
    "is_sufficient": true, // or false
    "knowledge_gap": "The summary lacks information about performance metrics an
d benchmarks", // "" if is_sufficient is true
    "follow_up_queries": ["What are typical performance benchmarks and metrics u
sed to evaluate [specific technology]?"] // [] if is_sufficient is true
}}}}
```

Reflect carefully on the Summaries to identify knowledge gaps and produce a foll
ow-up query. Then, produce your output following this JSON format:

Summaries:
{{summaries}}
"""

answer_instructions = """Generate a high-quality answer to the user's question b
ased on the provided summaries.

Instructions:
- The current date is {{current_date}}.
- You are the final step of a multi-step research process, don't mention that yo
u are the final step.
- You have access to all the information gathered from the previous steps.
- You have access to the user's question.
- Generate a high-quality answer to the user's question based on the provided su
mmaries and the user's question.
- you MUST include all the citations from the summaries in the answer correctly.

User Context:
- {{research_topic}}

Summaries:
{{summaries}}"""

biography_instructions = """
Generate a comprehensive and well-structured biography about {research_topic}, drawing from the provided summaries. The biography should be suitable for a standalone document.

Instructions:
- The current date is {current_date}.
- Base the biography *only* on the information contained within the provided summaries. Do not add external knowledge.
- Structure the biography with clear sections. Consider using headings such as:
    - Early Life and Background
    - Education and Influences
    - Key Accomplishments and Contributions
    - Challenges and Obstacles Overcome (if applicable from summaries)
    - Impact and Legacy
    - References (ensure all citations from the summaries are correctly placed here or inline as appropriate)
- Write in a narrative and engaging style.
- Ensure meticulous inclusion of all citations from the summaries.

User Context (Research Topic):
- {research_topic}

Summaries:
{summaries}
"""
