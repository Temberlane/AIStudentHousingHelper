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

const listings = [
  {
    id: 1,
    title: 'Campus Commons - Studio',
    location: 'near campus',
    bedrooms: 0,
    price: 950,
    url: 'https://example.com/campus-commons-studio'
  },
  {
    id: 2,
    title: 'Maple Street Apartments - 2BR',
    location: 'maple street',
    bedrooms: 2,
    price: 1450,
    url: 'https://example.com/maple-2br'
  },
  {
    id: 3,
    title: 'Downtown Loft - 1BR',
    location: 'downtown',
    bedrooms: 1,
    price: 1300,
    url: 'https://example.com/downtown-loft'
  },
  {
    id: 4,
    title: 'Greenway Homes - 3BR',
    location: 'greenway',
    bedrooms: 3,
    price: 1850,
    url: 'https://example.com/greenway-3br'
  }
];

function searchListings(preferences) {
  const normalizedLocation = (preferences.location || '').toLowerCase();
  const budget = preferences.budget || Number.MAX_SAFE_INTEGER;
  const bedrooms = Number.isFinite(preferences.bedrooms) ? preferences.bedrooms : 0;

  const filtered = listings
    .filter((listing) =>
      (!normalizedLocation || listing.location.includes(normalizedLocation)) &&
      listing.price <= budget &&
      listing.bedrooms >= bedrooms
    )
    .sort((a, b) => a.price - b.price || b.bedrooms - a.bedrooms);

  return filtered.length ? filtered : listings.sort((a, b) => a.price - b.price);
}

app.post('/voice', (req, res) => {
  console.log('Received /voice webhook');
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ input: 'speech', action: '/handle-intent', method: 'POST' });
  gather.say('Welcome to the student housing helper. Please describe your preferred location, budget, and number of bedrooms.');
  twiml.say('If you are disconnected, we will text you the best options.');
  res.type('text/xml').send(twiml.toString());
});

app.post('/handle-intent', async (req, res) => {
  console.log('Handling intent with body:', req.body);
  const userSpeech = req.body.SpeechResult || req.body.TranscriptionText || '';
  const fallbackPreferences = { location: 'campus', budget: 1500, bedrooms: 1 };

  const prompt = `Extract the desired location, maximum budget in USD, and minimum bedrooms from the user's request.
Return a JSON object with keys: location (string), budget (number), bedrooms (number).
User request: "${userSpeech || 'None provided'}"`;

  let preferences = fallbackPreferences;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract structured housing preferences.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' }
    });

    const content = response.choices?.[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content);
      preferences = {
        location: parsed.location || fallbackPreferences.location,
        budget: Number(parsed.budget) || fallbackPreferences.budget,
        bedrooms: Number(parsed.bedrooms) || fallbackPreferences.bedrooms
      };
    }
    console.log('Extracted preferences:', preferences);
  } catch (error) {
    console.error('Failed to parse preferences. Using fallback.', error);
  }

  const matchedListings = searchListings(preferences);
  const topListings = matchedListings.slice(0, 3);

  const smsBody = topListings
    .map((listing, idx) => `${idx + 1}) ${listing.title} - ${listing.bedrooms}BR - $${listing.price}/mo - ${listing.url}`)
    .join('\n');

  if (req.body.From && smsBody) {
    try {
      await twilioClient.messages.create({
        body: `Thanks for calling! Here are your matches based on location: ${preferences.location}, budget: $${preferences.budget}, bedrooms: ${preferences.bedrooms}.\n${smsBody}`,
        from: process.env.TWILIO_FROM_NUMBER,
        to: req.body.From
      });
      console.log('Sent SMS with listings to', req.body.From);
    } catch (error) {
      console.error('Failed to send SMS', error);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const best = topListings[0];
  if (best) {
    twiml.say(`I found ${topListings.length} options. The first is ${best.title} in ${best.location} for ${best.price} dollars per month with ${best.bedrooms} bedrooms.`);
  } else {
    twiml.say('I could not find a good match, but we will text you options soon.');
  }
  twiml.say('Thank you for calling. Goodbye.');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
