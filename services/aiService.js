const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');
const Settings = require('../models/Settings');
const logger = require('../config/logger');

/**
 * Strip trailing <br> tags / empty <p></p> the AI sometimes leaves at the
 * end of its generated body, so they don't stack with the hardcoded <br>
 * before "Best Regards" and create an oversized gap.
 */
function cleanTrailingHtml(html) {
  let cleaned = html.trim();
  let prevLength;
  do {
    prevLength = cleaned.length;
    cleaned = cleaned
      .replace(/(<br\s*\/?>)+\s*$/gi, '')
      .replace(/<p>\s*(&nbsp;|\s)*<\/p>\s*$/gi, '')
      .trim();
  } while (cleaned.length !== prevLength);
  return cleaned;
}

/**
 * Generate initial cold email using Google Gemini or Fallback Groq.
 */
exports.generateColdEmail = async (lead) => {
  const settings = await Settings.getSettings();
  const logs = [];

  const prompt = `
You are a senior sales representative for Futurise Solutions writing a cold outreach email to a prospective client.
Your goal: write a highly personalized, concise, and conversion-focused cold email that gets a reply.

Lead Information:
- Name: ${lead.name}
- Company: ${lead.company}
- Role: ${lead.role}
- Industry: ${lead.industry || 'Not Specified'}
- Website: ${lead.website || 'Not Specified'}
- LinkedIn: ${lead.linkedin || 'Not Specified'}

About Futurise Solutions:
- We build custom Web Apps (React, Node.js), AI-powered automation workflows, and digital growth solutions.
- We help mid-to-large businesses eliminate manual bottlenecks, integrate systems, and scale operations efficiently.

Writing Rules (follow strictly):
1. Keep the TOTAL email body between 180-210 words.
2. Open with ONE sentence that shows you understand their specific role/company/industry challenge — make them feel this email was written just for them.
3. In 2-3 sentences, connect their specific pain point to what we solve — be concrete, not generic.
4. Add ONE short paragraph (2-3 sentences) with a concrete example of the kind of result or capability we deliver (e.g. a specific workflow, integration, or efficiency gain relevant to their industry) — still no invented client names or fake stats.
5. End with a single, low-pressure CTA that asks a specific question or proposes a short call ("Would a 15-minute call this week make sense?"). NEVER name a specific day of the week (no "Thursday", "Friday", etc.).
6. Do NOT use spammy or AI-sounding words: "Guarantee", "Free", "Risk-free", "delve", "testament", "revolutionary", "game-changer", "streamline", "leverage", "unlock potential".
7. Subject line: Professional, specific to their role/industry, under 10 words, no emojis.
8. Sound like a real person — conversational, direct, confident but not pushy.
9. Do NOT include any sign-off, "Best Regards", or signature — the body ends immediately after the CTA.
10. Format the body as clean HTML (use <p> tags, <strong> for emphasis). Include a plain-text version.

Respond ONLY in this JSON format:
{
  "subject": "Subject line here",
  "html": "<p>HTML email body ending after CTA. No sign-off or signature.</p>",
  "text": "Plain-text email body ending after CTA. No sign-off or signature."
}
`;

  const plaintextSignature = settings.companySignature
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .trim();

  // 1. Try Gemini (Primary)
  if (settings.geminiApiKey) {
    try {
      logger.info(`Attempting to generate email for ${lead.email} using Gemini...`);
      const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const responseText = response.text;
      const emailContent = JSON.parse(responseText.trim());

      return {
        subject: emailContent.subject,
        html: `${cleanTrailingHtml(emailContent.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\nBest Regards,\n${plaintextSignature}`,
        provider: 'gemini'
      };
    } catch (err) {
      const errorMsg = err.message || 'Unknown Gemini Error';
      logger.error(`Gemini generation failed: ${errorMsg}`);
      logs.push({
        timestamp: new Date(),
        stage: 'ai_generation',
        provider: 'gemini',
        reason: errorMsg
      });
    }
  } else {
    logger.warn('Gemini API Key is missing. Skipping Gemini...');
    logs.push({
      timestamp: new Date(),
      stage: 'ai_generation',
      provider: 'gemini',
      reason: 'Gemini API key is not configured.'
    });
  }

  // 2. Try Groq (Fallback)
  if (settings.groqApiKey) {
    try {
      logger.info(`Attempting fallback email generation for ${lead.email} using Groq...`);
      const groq = new Groq({ apiKey: settings.groqApiKey });

      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' }
      });

      const responseText = chatCompletion.choices[0].message.content;
      const emailContent = JSON.parse(responseText.trim());

      return {
        subject: emailContent.subject,
        html: `${cleanTrailingHtml(emailContent.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\nBest Regards,\n${plaintextSignature}`,
        provider: 'groq',
        warnings: logs
      };
    } catch (err) {
      const errorMsg = err.message || 'Unknown Groq Error';
      logger.error(`Groq fallback generation failed: ${errorMsg}`);
      logs.push({
        timestamp: new Date(),
        stage: 'ai_generation',
        provider: 'groq',
        reason: errorMsg
      });
    }
  } else {
    logger.warn('Groq API Key is missing. Fallback skipped.');
    logs.push({
      timestamp: new Date(),
      stage: 'ai_generation',
      provider: 'groq',
      reason: 'Groq API key is not configured.'
    });
  }

  // If both failed, throw aggregated error logs
  const error = new Error('AI Generation failed for both Gemini and Groq.');
  error.logs = logs;
  throw error;
};

/**
 * Generate follow-up email.
 */
exports.generateFollowUpEmail = async (lead, previousEmailContent, followupNumber) => {
  const settings = await Settings.getSettings();
  const logs = [];

  const prompt = `
You are a senior sales representative for Futurise Solutions writing Follow-Up Email #${followupNumber} to ${lead.name} (${lead.role} at ${lead.company}).

Previous email context:
---
Subject: ${previousEmailContent.subject}
Body:
${previousEmailContent.text}
---

Writing Rules (follow strictly):
1. Keep it ${followupNumber === 1 ? 'short — under 80 words total' : 'between 120-150 words total'}.
2. Open with a brief, natural reference to the previous email (1 sentence max) — do NOT sound pushy or passive-aggressive.
3. ${followupNumber === 1
  ? 'Mention you\'ve attached the Futurise Solutions Catalogue and ask one specific, easy-to-answer question about their current challenges.'
  : 'Offer one concrete, fresh angle (a specific result we\'ve helped similar companies achieve) with 1-2 sentences of supporting detail, then ask for a quick 10-minute call at their convenience.'}
4. CTA must be specific and low-friction — avoid vague asks like "let me know if you're interested". NEVER name a specific day of the week (no "Thursday", "Friday", etc.) — say "this week" or "at your convenience" instead.
5. Do NOT use: "I hope this finds you well", "Just checking in", "circle back", "touch base", "synergy", "leverage", "streamline".
6. Sound like a real person — conversational and direct.
7. Do NOT include any sign-off, "Best Regards", or signature. Body ends immediately after CTA.
8. Respond ONLY in this JSON format:

{
  "subject": "Re: ${previousEmailContent.subject.replace(/^Re:\s*/i, '')}",
  "html": "<p>HTML follow-up body. No sign-off or signature.</p>",
  "text": "Plain-text follow-up body. No sign-off or signature."
}
`;

  const plaintextSignature = settings.companySignature
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .trim();

  // 1. Try Gemini (Primary)
  if (settings.geminiApiKey) {
    try {
      logger.info(`Attempting to generate Followup #${followupNumber} for ${lead.email} using Gemini...`);
      const ai = new GoogleGenAI({ apiKey: settings.geminiApiKey });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const responseText = response.text;
      const emailContent = JSON.parse(responseText.trim());

      return {
        subject: emailContent.subject,
        html: `${cleanTrailingHtml(emailContent.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\nBest Regards,\n${plaintextSignature}`,
        provider: 'gemini'
      };
    } catch (err) {
      logger.error(`Gemini followup generation failed: ${err.message}`);
      logs.push({
        timestamp: new Date(),
        stage: 'ai_followup',
        provider: 'gemini',
        reason: err.message
      });
    }
  }

  // 2. Try Groq (Fallback)
  if (settings.groqApiKey) {
    try {
      logger.info(`Attempting fallback Followup #${followupNumber} for ${lead.email} using Groq...`);
      const groq = new Groq({ apiKey: settings.groqApiKey });

      const chatCompletion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
        response_format: { type: 'json_object' }
      });

      const responseText = chatCompletion.choices[0].message.content;
      const emailContent = JSON.parse(responseText.trim());

      return {
        subject: emailContent.subject,
        html: `${cleanTrailingHtml(emailContent.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\nBest Regards,\n${plaintextSignature}`,
        provider: 'groq',
        warnings: logs
      };
    } catch (err) {
      logger.error(`Groq fallback followup generation failed: ${err.message}`);
      logs.push({
        timestamp: new Date(),
        stage: 'ai_followup',
        provider: 'groq',
        reason: err.message
      });
    }
  }

  const error = new Error(`AI Follow Up Generation failed for both Gemini and Groq.`);
  error.logs = logs;
  throw error;
};

/**
 * Generate Suggested Response for a replied lead.
 */
exports.suggestReplyResponse = async (lead, emailHistoryList) => {
  const settings = await Settings.getSettings();

  const formattedThread = emailHistoryList.map(h => `
[${h.sentAt.toISOString()}] SENT BY US (${h.type}):
Subject: ${h.subject}
Body: ${h.text}
  `).join('\n---\n');

  const prompt = `
You are a sales representative at Futurise Solutions. A prospective lead has replied to our cold outreach. 
You need to draft a professional, helpful response addressing their reply and pushing for a meeting or clarifying their questions.

Lead Information:
- Name: ${lead.name}
- Company: ${lead.company}
- Role: ${lead.role}

Customer's Reply:
"${lead.replyText}"

Outreach Thread History:
${formattedThread}

Writing Rules:
1. Address the lead's concerns or questions directly, showing empathy and professionalism.
2. Keep it clear, concise, and focused on securing a meeting or answering their query.
3. Do NOT include any sign-off or company signature at the end. The suggestion body must end immediately after your closing thoughts or meeting request.
4. NEVER name a specific day of the week (no "Thursday", "Friday", etc.) when proposing a meeting — say "this week" or "at your convenience" instead.
5. Output the response in standard JSON format:

{
  "subject": "Re: ${emailHistoryList[0] ? emailHistoryList[0].subject.replace(/^Re:\s*/i, '') : 'Our conversation'}",
  "html": "<p>HTML formatted response. Do not include signature.</p>",
  "text": "Plain text formatted response."
}
`;

  // Use Gemini for suggestions (no strict fallback needed for suggestions, simple try/catch is fine)
  if (!settings.geminiApiKey && !settings.groqApiKey) {
    throw new Error('Please configure either a Gemini or Groq API Key to suggest replies.');
  }

  const apiKey = settings.geminiApiKey || settings.groqApiKey;
  const isGemini = !!settings.geminiApiKey;

  const plaintextSignature = settings.companySignature
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .trim();

  if (isGemini) {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' }
    });
    const parsed = JSON.parse(response.text.trim());
    return {
      subject: parsed.subject,
      html: `${cleanTrailingHtml(parsed.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
      text: `${parsed.text.trim()}\n\nBest Regards,\n${plaintextSignature}`
    };
  } else {
    const groq = new Groq({ apiKey });
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(chatCompletion.choices[0].message.content.trim());
    return {
      subject: parsed.subject,
      html: `${cleanTrailingHtml(parsed.html)}<p style="margin:4px 0 4px 0;">Best Regards,</p>${settings.companySignature}`,
      text: `${parsed.text.trim()}\n\nBest Regards,\n${plaintextSignature}`
    };
  }
};
