const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');
const Settings = require('../models/Settings');
const logger = require('../config/logger');

/**
 * Generate initial cold email using Google Gemini or Fallback Groq.
 */
exports.generateColdEmail = async (lead) => {
  const settings = await Settings.getSettings();
  const logs = [];

  const prompt = `
You are a sales representative for Futurise Solutions. 
Your goal is to write a highly personalized, compelling, professional, and short cold email to a prospective lead.

Lead Information:
- Name: ${lead.name}
- Email: ${lead.email}
- Company: ${lead.company}
- Role: ${lead.role}
- Industry: ${lead.industry || 'Not Specified'}
- Website: ${lead.website || 'Not Specified'}
- LinkedIn: ${lead.linkedin || 'Not Specified'}

Our Company (Futurise Solutions) Details:
- We specialize in high-end Web & Web App Development (React, Vite, Node.js), custom AI solutions, digital marketing, and automated workflows.

Writing Rules:
1. Keep the email short (under 120-150 words).
2. Establish relevance immediately in the opening line (reference their role/company).
3. Do NOT use spammy words like "Guarantee", "Free", "Risk-free", "Act now", "Miracle".
4. Sound natural, friendly, and human (no overly formal AI buzzwords like "delve", "testament", "revolutionary", "game-changer").
5. The subject line should be catchy, professional, and relevant (no emojis, not clickbaity).
6. Provide a clear and low-friction Call to Action (CTA).
7. Do NOT include any sign-off (such as "Sincerely", "Regards", "Best regards") or company signature/contact information at the end. The email body must end immediately after your CTA.
8. Format the output as a clean HTML email (use standard paragraph tags, bold text where appropriate, etc.) along with a plain-text backup.

You MUST respond strictly in the following JSON format:
{
  "subject": "Email Subject Line Here",
  "html": "<p>HTML-formatted email body ending right after CTA. Add line breaks using tags. Do not include signature.</p>",
  "text": "Plain-text version of the email body ending right after CTA."
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
        html: `${emailContent.html.trim()}<br><br>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\n${plaintextSignature}`,
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
        html: `${emailContent.html.trim()}<br><br>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\n${plaintextSignature}`,
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
You are a sales representative for Futurise Solutions. 
You are writing Follow-Up Email #${followupNumber} to ${lead.name} (${lead.role} at ${lead.company}).

Here is the context of the previous email sent to them:
---
Subject: ${previousEmailContent.subject}
Body: 
${previousEmailContent.text}
---

Writing Rules:
1. Reference our previous message briefly and politely, without sounding pushy or passive-aggressive.
2. Keep it extremely short (under 80-100 words).
3. Offer a fresh value proposition or ask a simple question.
4. ${followupNumber === 1 ? 'Mention that you have attached the Futurise Solutions Catalogue PDF for their convenience.' : 'Do NOT mention any attachments.'}
5. Do NOT use spammy words.
6. Do NOT include any sign-off (such as "Sincerely", "Regards", "Best regards") or company signature/contact information at the end. The email body must end immediately after your CTA or value proposition.
7. Must respond in standard JSON format:

{
  "subject": "Re: ${previousEmailContent.subject.replace(/^Re:\s*/i, '')}",
  "html": "<p>HTML-formatted email follow-up body. Do not include signature.</p>",
  "text": "Plain-text version of the follow-up body."
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
        html: `${emailContent.html.trim()}<br><br>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\n${plaintextSignature}`,
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
        html: `${emailContent.html.trim()}<br><br>${settings.companySignature}`,
        text: `${emailContent.text.trim()}\n\n${plaintextSignature}`,
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
4. Output the response in standard JSON format:

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
      html: `${parsed.html.trim()}<br><br>${settings.companySignature}`,
      text: `${parsed.text.trim()}\n\n${plaintextSignature}`
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
      html: `${parsed.html.trim()}<br><br>${settings.companySignature}`,
      text: `${parsed.text.trim()}\n\n${plaintextSignature}`
    };
  }
};
