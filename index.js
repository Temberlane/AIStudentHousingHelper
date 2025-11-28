// Setup: create a .env file with OPENAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.
// Install dependencies with `npm install` and launch the server with `npm start`.
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sessions = {};

const listings = [
  {
    id: 1,
    title: 'Room in 3-bed near uOttawa',
    city: 'Ottawa',
    price: 850,
    distanceToCampusMinutes: 8,
    bedrooms: 1,
    description: 'Utilities included, furnished, near LRT. In a safe neighborhood and quiet neighbours. No smoking.',
    url: 'https://example.com/uottawa-room'
  },
  {
    id: 2,
    title: 'Studio close to Waterloo campus',
    city: 'Waterloo',
    price: 1200,
    distanceToCampusMinutes: 12,
    bedrooms: 1,
    description: 'All included, furnished.',
    url: 'https://example.com/waterloo-studio'
  },
  {
    id: 3,
    title: 'Basement room near downtown Toronto',
    city: 'Toronto',
    price: 1100,
    distanceToCampusMinutes: 20,
    bedrooms: 1,
    description: 'Furnished room, utilities extra.',
    url: 'https://example.com/toronto-basement'
  },
  {
    id: 4,
    title: '2-bed apartment near UofT St. George',
    city: 'Toronto',
    price: 2100,
    distanceToCampusMinutes: 10,
    bedrooms: 2,
    description: 'Great for roommates, utilities included.',
    url: 'https://example.com/toronto-2bed'
  }
];

function searchListings(city, minBudget, maxBudget, bedrooms) {
  const normalizedCity = (city || '').toLowerCase();
  const min = Number.isFinite(minBudget) ? minBudget : 0;
  const max = Number.isFinite(maxBudget) ? maxBudget : Number.MAX_SAFE_INTEGER;
  const beds = Number.isFinite(bedrooms) ? bedrooms : null;

  const filtered = listings
    .filter((listing) =>
      (!normalizedCity || listing.city.toLowerCase().includes(normalizedCity)) &&
      listing.price >= min &&
      listing.price <= max &&
      (beds === null || listing.bedrooms >= beds)
    )
    .sort((a, b) => a.price - b.price || a.distanceToCampusMinutes - b.distanceToCampusMinutes);

  return filtered.length ? filtered : listings.sort((a, b) => a.price - b.price);
}

function initializeSession(callSid) {
  const greeting = 'Hey, this is House Helper, your student housing assistant. How can I help? What are you looking for in a place?';
  sessions[callSid] = {
    messages: [
      {
        role: 'system',
        content:
          'You are House Helper, a concise and friendly student housing assistant. Keep questions short. Keep the conversation focused on finding housing that fits the student. '
      },
      { role: 'assistant', content: greeting }
    ],
    slots: {
      city: null,
      min_budget: null,
      max_budget: null,
      move_in_date: null,
      bedrooms: null,
      roommates: null
    },
    turns: 0
  };
}

const completionSystemPrompt = `You are House Helper, a student housing assistant. You receive the full conversation history and current slot values (city, min_budget, max_budget, move_in_date, bedrooms, roommates).\nInfer and update the slots from what the user has shared so far. Determine if you have enough information to confidently recommend housing from the available listings metadata (city, price, distanceToCampusMinutes, description, bedrooms).\nIf more details are needed, ask one concise follow-up question. If enough info is present, set done to true.\nALWAYS respond with a single JSON object only in this shape and nothing else:\n{\n  "slots": {\n    "city": "Toronto",\n    "min_budget": 800,\n    "max_budget": 1500,\n    "move_in_date": "2026-09-01",\n    "bedrooms": 1,\n    "roommates": 0\n  },\n  "done": false,\n  "next_question": "Can you tell me your monthly budget range for rent?"\n}\nWhen done is false, next_question must be a single follow-up question. When done is true, next_question should be a short summary or null.`;

function buildUserMessage(session, speechText) {
  const history = session.messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const slotsSummary = JSON.stringify(session.slots);
  return `Current slots: ${slotsSummary}\nConversation history:\n${history}\nLatest user input: ${speechText}`;
}

app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid || `call-${Date.now()}`;
  if (!sessions[callSid]) {
    initializeSession(callSid);
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ input: 'speech', action: '/handle-intent', method: 'POST', timeout: 5, speechTimeout: 'auto' });
  gather.say('Hey, this is House Helper, your student housing assistant. How can I help? What are you looking for in a place?');
  res.type('text/xml').send(twiml.toString());
});

app.post('/handle-intent', async (req, res) => {
  const callSid = req.body.CallSid || `call-${Date.now()}`;
  if (!sessions[callSid]) {
    initializeSession(callSid);
  }
  const session = sessions[callSid];

  const speechText = req.body.SpeechResult || req.body.TranscriptionText || '';
  session.messages.push({ role: 'user', content: speechText });
  session.turns += 1;

  let parsedResponse = null;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: completionSystemPrompt },
        { role: 'user', content: buildUserMessage(session, speechText) }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });
    const content = response.choices?.[0]?.message?.content;
    if (content) {
      parsedResponse = JSON.parse(content);
    }
  } catch (error) {
    console.error('OpenAI parsing failed, using fallback', error);
  }

  const fallbackSlots = {
    city: session.slots.city || 'Toronto',
    min_budget: session.slots.min_budget || 600,
    max_budget: session.slots.max_budget || 2500,
    move_in_date: session.slots.move_in_date,
    bedrooms: session.slots.bedrooms,
    roommates: session.slots.roommates
  };

  if (!parsedResponse || parsedResponse.slots === undefined || parsedResponse.done === undefined) {
    parsedResponse = { slots: fallbackSlots, done: true, next_question: null };
  }

  Object.entries(parsedResponse.slots || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && key in session.slots) {
      session.slots[key] = value;
    }
  });

  const maxTurns = 5;
  if (session.turns > maxTurns) {
    parsedResponse.done = true;
  }

  if (!parsedResponse.done) {
    const question = parsedResponse.next_question || 'Can you share a bit more about your budget and move-in date?';
    session.messages.push({ role: 'assistant', content: question });

    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({ input: 'speech', action: '/handle-intent', method: 'POST', timeout: 5, speechTimeout: 'auto' });
    gather.say(question);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  const searchCity = session.slots.city || 'Toronto';
  const minBudget = Number(session.slots.min_budget) || 0;
  const maxBudget = Number(session.slots.max_budget) || Number.MAX_SAFE_INTEGER;
  const bedrooms = Number(session.slots.bedrooms);

  const matchedListings = searchListings(searchCity, minBudget, maxBudget, Number.isFinite(bedrooms) ? bedrooms : null);
  const topListings = matchedListings.slice(0, 3);

  const spokenSummary = topListings.length
    ? `Based on what you told me, I found ${topListings.length} place${topListings.length > 1 ? 's' : ''} in ${searchCity} between ${minBudget} and ${maxBudget} dollars. First, ${topListings[0].title} at ${topListings[0].price} dollars per month, about ${topListings[0].distanceToCampusMinutes} minutes from campus.`
    : 'I could not find a strong match, but I will text you the options I have.';

  const smsBody = topListings
    .map(
      (listing, idx) =>
        `${idx + 1}) ${listing.title} - ${listing.city} - ${listing.bedrooms}BR - $${listing.price}/mo - ${listing.distanceToCampusMinutes} mins to campus. ${listing.description} ${listing.url || ''}`
    )
    .join('\n');

  if (req.body.From && smsBody) {
    try {
      await twilioClient.messages.create({
        body: `Based on what you shared (city: ${searchCity}, budget: ${minBudget}-${maxBudget}, bedrooms: ${session.slots.bedrooms || 'any'}), here are options:\n${smsBody}`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: req.body.From
      });
      console.log('Sent SMS with listings to', req.body.From);
    } catch (error) {
      console.error('Failed to send SMS', error);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(spokenSummary);
  twiml.say('I\'ve texted you the details. Thanks for using House Helper. Goodbye.');
  twiml.hangup();

  delete sessions[callSid];
  res.type('text/xml').send(twiml.toString());
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
