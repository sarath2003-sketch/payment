/**
 * Universal Google Gemini 2-Way Voice AI Assistant Controller
 * Bilingual (Tamil & English) with Dual-Engine TTS, Live Mic STT & Autonomous Backend Self-Healing
 */
(function() {
  'use strict';

  var currentLang = 'ta'; // 'ta' (Tamil) or 'en' (English)
  var isListening = false;
  var isSpeaking = false;
  var isChatView = false;
  var recognition = null;
  var currentAudio = null;
  var sessionId = 'gemini-session-' + Date.now();
  var restartListenTimeout = null;

  var GREETING_TA = 'ஹலோ சொல்லுங்க! உங்களுக்கு நான் என்ன உதவி பண்ணனும்?';
  var GREETING_EN = 'Hello! How can I help you today?';

  // 1. Ensure HTML and Floating UI Elements are present in the DOM
  function ensureAssistantElements() {
    if (!document.getElementById('floatingAiBtn')) {
      var btn = document.createElement('button');
      btn.id = 'floatingAiBtn';
      btn.className = 'gemini-float-btn';
      btn.setAttribute('aria-label', 'Open Gemini AI Assistant');
      btn.title = '✨ Google Gemini Voice Assistant / தமிழ் AI அசிஸ்டெண்ட்';
      btn.innerHTML = '<div class="gemini-float-btn-inner">✨</div>';
      btn.onclick = window.openGeminiAssistant;
      document.body.appendChild(btn);
    }

    if (!document.getElementById('geminiAssistantModal')) {
      var modal = document.createElement('div');
      modal.id = 'geminiAssistantModal';
      modal.className = 'gemini-backdrop hidden';
      modal.innerHTML = [
        '<div class="gemini-card">',
        '  <!-- Header -->',
        '  <div class="gemini-header">',
        '    <div class="gemini-badge">',
        '      <span class="gemini-sparkle">✨</span>',
        '      <div>',
        '        <span class="gemini-title">Gemini AI Copilot</span>',
        '        <span class="gemini-subtitle" id="geminiStatusSubtitle">Online • ரெடி</span>',
        '      </div>',
        '    </div>',
        '    <div style="display:flex;align-items:center;gap:8px">',
        '      <button type="button" id="geminiLangToggleBtn" class="gemini-lang-pill" onclick="window.geminiToggleLanguage()" title="மொழி மாற்று / Toggle Language">',
        '        🇮🇳 தமிழ்',
        '      </button>',
        '      <button type="button" class="gemini-icon-btn" onclick="window.geminiToggleView()" id="geminiViewToggleBtn" title="சாட் பார்வை / Chat View">',
        '        💬',
        '      </button>',
        '      <button type="button" class="gemini-icon-btn gemini-close-btn" onclick="window.closeGeminiAssistant()" title="மூடு / Close">',
        '        ✕',
        '      </button>',
        '    </div>',
        '  </div>',
        '',
        '  <!-- VOICE VIEW (DEFAULT) -->',
        '  <div id="geminiVoiceView" class="gemini-voice-body">',
        '    <div class="gemini-orb-wrapper" id="geminiOrbWrapper" onclick="window.geminiToggleMic()" title="மைக் ஆன் / ஆஃப் (டேப் செய்யவும்)">',
        '      <div class="gemini-orb-glow"></div>',
        '      <div class="gemini-orb-core">',
        '        <span class="gemini-orb-icon" id="geminiOrbIcon">✨</span>',
        '      </div>',
        '    </div>',
        '',
        '    <div class="gemini-soundwaves" id="geminiSoundwaves">',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '      <div class="gemini-wave-bar"></div>',
        '    </div>',
        '',
        '    <div class="gemini-voice-feedback">',
        '      <div class="gemini-voice-status" id="geminiVoiceStatus">மைக் ஆன் செய்ய தட்டவும்...</div>',
        '      <div class="gemini-speech-bubble" id="geminiSpeechBubble">',
        '        "ஹலோ சொல்லுங்க! உங்களுக்கு நான் என்ன உதவி பண்ணனும்?"',
        '      </div>',
        '    </div>',
        '',
        '    <div id="geminiActionBanner" class="gemini-action-banner hidden"></div>',
        '',
        '    <div class="gemini-voice-controls">',
        '      <button type="button" class="gemini-mic-action-btn" id="geminiMicBtn" onclick="window.geminiToggleMic()">',
        '        <span id="geminiMicIcon">🎤</span> <span id="geminiMicLabel">பேசுங்கள் (Speak)</span>',
        '      </button>',
        '      <button type="button" class="gemini-stop-speech-btn" id="geminiStopSpeechBtn" onclick="window.geminiStopSpeaking()" style="display:none;">',
        '        ⏹ நிறுத்து',
        '      </button>',
        '    </div>',
        '  </div>',
        '',
        '  <!-- CHAT VIEW -->',
        '  <div id="geminiChatView" class="gemini-chat-body hidden">',
        '    <div class="gemini-messages" id="geminiMessagesContainer">',
        '      <div class="gemini-msg gemini-msg-assistant">',
        '        <div class="gemini-msg-content">',
        '          ஹலோ சொல்லுங்க! உங்களுக்கு நான் என்ன உதவி பண்ணனும்?',
        '        </div>',
        '      </div>',
        '    </div>',
        '    <div class="gemini-chat-input-bar">',
        '      <input type="text" id="geminiChatInput" placeholder="செய்தியை தட்டச்சு செய்யவும்..." onkeydown="if(event.key===\'Enter\')window.geminiSendChatMessage()">',
        '      <button type="button" class="gemini-chat-send-btn" onclick="window.geminiSendChatMessage()">➤</button>',
        '    </div>',
        '  </div>',
        '',
        '  <!-- Quick Action Chips -->',
        '  <div class="gemini-chips-container">',
        '    <button type="button" class="gemini-chip" onclick="window.geminiSendQuickAction(\'எரர் எல்லாம் செக் பண்ணி சரி பண்ணு\')">',
        '      🛠️ எரர் சரி செய்',
        '    </button>',
        '    <button type="button" class="gemini-chip" onclick="window.geminiSendQuickAction(\'உறுப்பினர்கள் பட்டியல் மற்றும் எண்ணிக்கை சொல்\')">',
        '      👥 உறுப்பினர்கள் நிலை',
        '    </button>',
        '    <button type="button" class="gemini-chip" onclick="window.geminiSendQuickAction(\'பணம் வசூல் மற்றும் நிலுவைத் தொகை நிலவரம் என்ன?\')">',
        '      💰 கலெக்ஷன் விவரம்',
        '    </button>',
        '    <button type="button" class="gemini-chip" onclick="window.geminiSendQuickAction(\'டேட்டாபேஸ் மற்றும் உறுப்பினர்களை ரீஸ்டோர் செய்\')">',
        '      🔄 டேட்டா ரீஸ்டோர்',
        '    </button>',
        '  </div>',
        '</div>'
      ].join('\n');
      document.body.appendChild(modal);
    }
  }

  // 2. Orb State Animation Controller
  function setOrbState(state) {
    var wrapper = document.getElementById('geminiOrbWrapper');
    var icon = document.getElementById('geminiOrbIcon');
    var waves = document.getElementById('geminiSoundwaves');
    var subtitle = document.getElementById('geminiStatusSubtitle');
    var stopBtn = document.getElementById('geminiStopSpeechBtn');

    if (!wrapper) return;
    wrapper.classList.remove('gemini-orb-idle', 'gemini-orb-listening', 'gemini-orb-thinking', 'gemini-orb-speaking');

    if (state === 'listening') {
      wrapper.classList.add('gemini-orb-listening');
      if (icon) icon.textContent = '🎙️';
      if (waves) waves.classList.add('active');
      if (subtitle) subtitle.textContent = currentLang === 'ta' ? 'கேட்கிறது...' : 'Listening...';
      if (stopBtn) stopBtn.style.display = 'none';
    } else if (state === 'thinking') {
      wrapper.classList.add('gemini-orb-thinking');
      if (icon) icon.textContent = '⚙️';
      if (waves) waves.classList.remove('active');
      if (subtitle) subtitle.textContent = currentLang === 'ta' ? 'சிந்திக்கிறது...' : 'Processing...';
      if (stopBtn) stopBtn.style.display = 'none';
    } else if (state === 'speaking') {
      wrapper.classList.add('gemini-orb-speaking');
      if (icon) icon.textContent = '🔊';
      if (waves) waves.classList.add('active');
      if (subtitle) subtitle.textContent = currentLang === 'ta' ? 'பேசுகிறது...' : 'Speaking...';
      if (stopBtn) stopBtn.style.display = 'inline-block';
    } else {
      wrapper.classList.add('gemini-orb-idle');
      if (icon) icon.textContent = '✨';
      if (waves) waves.classList.remove('active');
      if (subtitle) subtitle.textContent = currentLang === 'ta' ? 'Online • ரெடி' : 'Online • Ready';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  // 3. Audio & Voice TTS Engine (Google TTS Audio + Web Speech Synthesis fallback)
  function stopSpeaking() {
    isSpeaking = false;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      } catch (e) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }
    setOrbState('idle');
  }

  function cleanSpokenText(text) {
    if (!text) return '';
    return text
      .replace(/[*#_`[\]()<>{}]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Split text into digestible chunks for seamless audio playback without timeout
  function splitTextIntoChunks(text, maxLength) {
    maxLength = maxLength || 140;
    var sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    var chunks = [];
    var current = '';

    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i].trim();
      if (!s) continue;
      if ((current + ' ' + s).length <= maxLength) {
        current = current ? (current + ' ' + s) : s;
      } else {
        if (current) chunks.push(current);
        if (s.length > maxLength) {
          var words = s.split(' ');
          var sub = '';
          for (var j = 0; j < words.length; j++) {
            if ((sub + ' ' + words[j]).length <= maxLength) {
              sub = sub ? (sub + ' ' + words[j]) : words[j];
            } else {
              if (sub) chunks.push(sub);
              sub = words[j];
            }
          }
          if (sub) chunks.push(sub);
          current = '';
        } else {
          current = s;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function playAudioChunkSequence(chunks, index, onComplete) {
    if (index >= chunks.length || !isSpeaking) {
      isSpeaking = false;
      setOrbState('idle');
      if (onComplete) onComplete();
      return;
    }

    var chunk = chunks[index];
    var langCode = currentLang === 'ta' ? 'ta' : 'en';
    var url = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=' + langCode + '&client=tw-ob&q=' + encodeURIComponent(chunk);

    var audio = new Audio(url);
    currentAudio = audio;

    audio.onended = function() {
      playAudioChunkSequence(chunks, index + 1, onComplete);
    };

    audio.onerror = function() {
      fallbackSpeak(chunk, function() {
        playAudioChunkSequence(chunks, index + 1, onComplete);
      });
    };

    var playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(function() {
        fallbackSpeak(chunk, function() {
          playAudioChunkSequence(chunks, index + 1, onComplete);
        });
      });
    }
  }

  function fallbackSpeak(text, onEnd) {
    if (!window.speechSynthesis) {
      if (onEnd) onEnd();
      return;
    }
    try {
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = currentLang === 'ta' ? 'ta-IN' : 'en-US';
      utter.rate = 0.95;
      utter.pitch = 1.0;
      utter.onend = function() {
        if (onEnd) onEnd();
      };
      utter.onerror = function() {
        if (onEnd) onEnd();
      };
      window.speechSynthesis.speak(utter);
    } catch (e) {
      if (onEnd) onEnd();
    }
  }

  function speakVoice(rawText, onComplete) {
    var text = cleanSpokenText(rawText);
    if (!text) {
      if (onComplete) onComplete();
      return;
    }

    stopSpeaking();
    isSpeaking = true;
    setOrbState('speaking');

    var chunks = splitTextIntoChunks(text, 140);
    playAudioChunkSequence(chunks, 0, function() {
      isSpeaking = false;
      setOrbState('idle');
      if (onComplete) onComplete();
    });
  }

  // 4. Live Microphone Speech-to-Text (STT)
  function initSpeechRecognition() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API not supported in this browser.');
      return null;
    }

    var rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = currentLang === 'ta' ? 'ta-IN' : 'en-IN';

    rec.onstart = function() {
      isListening = true;
      setOrbState('listening');
      updateMicButton(true);
      var statusEl = document.getElementById('geminiVoiceStatus');
      if (statusEl) {
        statusEl.textContent = currentLang === 'ta' ? '🎙️ நான் கேட்கிறேன், பேசுங்கள்...' : '🎙️ Listening to you...';
      }
    };

    rec.onresult = function(event) {
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }

      var statusEl = document.getElementById('geminiVoiceStatus');
      if (statusEl) statusEl.textContent = '🗣️ "' + transcript + '"';

      if (event.results[0].isFinal) {
        stopListening();
        handleUserMessage(transcript.trim());
      }
    };

    rec.onerror = function(event) {
      console.log('Voice recognition notice:', event.error);
      isListening = false;
      setOrbState('idle');
      updateMicButton(false);
      var statusEl = document.getElementById('geminiVoiceStatus');
      if (statusEl && event.error !== 'no-speech') {
        statusEl.textContent = currentLang === 'ta' ? 'மைக் எரர் (' + event.error + '). மீண்டும் முயற்சிக்கவும்.' : 'Mic error (' + event.error + '). Tap mic to retry.';
      }
    };

    rec.onend = function() {
      isListening = false;
      updateMicButton(false);
      if (!isSpeaking) setOrbState('idle');
    };

    return rec;
  }

  function startListening() {
    if (isSpeaking) {
      stopSpeaking();
    }
    if (restartListenTimeout) {
      clearTimeout(restartListenTimeout);
      restartListenTimeout = null;
    }

    try {
      if (!recognition) {
        recognition = initSpeechRecognition();
      }
      if (!recognition) {
        var statusEl = document.getElementById('geminiVoiceStatus');
        if (statusEl) {
          statusEl.textContent = currentLang === 'ta' ? '⚠️ உங்கள் உலாவியில் மைக் உள்ளீடு ஆதரிக்கப்படவில்லை. கீழே தட்டச்சு செய்யவும்.' : '⚠️ Speech input not supported. Please type below.';
        }
        return;
      }
      recognition.lang = currentLang === 'ta' ? 'ta-IN' : 'en-IN';
      recognition.start();
    } catch (e) {
      try {
        recognition.stop();
        setTimeout(function() {
          try { recognition.start(); } catch (err) {}
        }, 200);
      } catch (err) {}
    }
  }

  function stopListening() {
    isListening = false;
    updateMicButton(false);
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {}
    }
  }

  function updateMicButton(listening) {
    var micBtn = document.getElementById('geminiMicBtn');
    var micIcon = document.getElementById('geminiMicIcon');
    var micLabel = document.getElementById('geminiMicLabel');

    if (!micBtn) return;
    if (listening) {
      micBtn.classList.add('recording');
      if (micIcon) micIcon.textContent = '⏹';
      if (micLabel) micLabel.textContent = currentLang === 'ta' ? 'நிறுத்து (Stop)' : 'Stop Listening';
    } else {
      micBtn.classList.remove('recording');
      if (micIcon) micIcon.textContent = '🎤';
      if (micLabel) micLabel.textContent = currentLang === 'ta' ? 'பேசுங்கள் (Speak)' : 'Tap to Speak';
    }
  }

  // 5. User Message Dispatcher to Backend Copilot API
  function handleUserMessage(userText) {
    if (!userText || !userText.trim()) return;

    // Display user speech in UI
    var bubble = document.getElementById('geminiSpeechBubble');
    if (bubble) bubble.textContent = '🗣️ "' + userText + '"';

    appendChatMessage('user', userText);
    setOrbState('thinking');

    var statusEl = document.getElementById('geminiVoiceStatus');
    if (statusEl) {
      statusEl.textContent = currentLang === 'ta' ? '✨ ஜெமினி பதிலளிக்கிறது...' : '✨ Gemini is thinking...';
    }

    // Call Backend AI Copilot
    fetch('/api/ai-copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userText,
        lang: currentLang,
        sessionId: sessionId
      })
    })
    .then(function(res) {
      return res.json();
    })
    .then(function(data) {
      if (data.lang) {
        currentLang = data.lang;
        updateLangButtonUI();
      }

      var replyText = data.reply || (currentLang === 'ta' ? 'மன்னிக்கவும், தகவலைப் பெற முடியவில்லை.' : 'Sorry, could not process that.');
      var spokenText = data.spoken_text || replyText;

      // Update Speech Bubble
      if (bubble) bubble.textContent = replyText;

      // Add to Chat View
      appendChatMessage('assistant', replyText);

      // Render Action Banner if healing or actions performed
      var actionBanner = document.getElementById('geminiActionBanner');
      if (actionBanner) {
        if (data.actions_taken && data.actions_taken.length > 0) {
          actionBanner.classList.remove('hidden');
          var actionMsg = '';
          if (data.actions_taken.indexOf('RESTORE_MEMBERS') !== -1) {
            actionMsg += '✅ ' + (currentLang === 'ta' ? 'உறுப்பினர்கள் வெற்றிகரமாக மீட்டெடுக்கப்பட்டனர்! ' : 'Members successfully restored! ');
          }
          if (data.actions_taken.indexOf('EXECUTE_HEAL') !== -1) {
            actionMsg += '🛠️ ' + (currentLang === 'ta' ? 'கணினி பிழைகள் சரிசெய்யப்பட்டு நிலைப்படுத்தப்பட்டன!' : 'System errors diagnosed & resolved!');
          }
          actionBanner.textContent = actionMsg || '✅ நடவடிக்கை வெற்றிகரமாக முடிந்தது';
        } else {
          actionBanner.classList.add('hidden');
        }
      }

      // Speak response aloud, then re-arm mic for seamless 2-way conversation
      speakVoice(spokenText, function() {
        var st = document.getElementById('geminiVoiceStatus');
        if (st) {
          st.textContent = currentLang === 'ta' ? '🎙️ உங்கள் பதிலைச் சொல்லலாம் (Ready to listen)...' : '🎙️ Ready for your reply...';
        }
        restartListenTimeout = setTimeout(function() {
          if (!isSpeaking && !isChatView && document.getElementById('geminiAssistantModal') && !document.getElementById('geminiAssistantModal').classList.contains('hidden')) {
            startListening();
          }
        }, 800);
      });
    })
    .catch(function(err) {
      console.error('Gemini Copilot Error:', err);
      setOrbState('idle');
      var errMsg = currentLang === 'ta' ? 'மன்னிக்கவும், சர்வர் இணைப்பில் பிழை ஏற்பட்டது. மீண்டும் முயற்சிக்கவும்.' : 'Sorry, connection error with server.';
      if (bubble) bubble.textContent = errMsg;
      speakVoice(errMsg);
    });
  }

  // 6. UI Helpers & Chat Management
  function appendChatMessage(sender, text) {
    var container = document.getElementById('geminiMessagesContainer');
    if (!container) return;

    var msgDiv = document.createElement('div');
    msgDiv.className = 'gemini-msg ' + (sender === 'user' ? 'gemini-msg-user' : 'gemini-msg-assistant');
    msgDiv.innerHTML = '<div class="gemini-msg-content">' + text.replace(/\n/g, '<br>') + '</div>';
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
  }

  function updateLangButtonUI() {
    var langBtn = document.getElementById('geminiLangToggleBtn');
    if (langBtn) {
      langBtn.textContent = currentLang === 'ta' ? '🇮🇳 தமிழ்' : '🇬🇧 English';
    }
  }

  // 7. Global Public Window Methods
  window.openGeminiAssistant = function() {
    ensureAssistantElements();
    var modal = document.getElementById('geminiAssistantModal');
    if (modal) modal.classList.remove('hidden');

    var banner = document.getElementById('geminiActionBanner');
    if (banner) banner.classList.add('hidden');

    var greeting = currentLang === 'ta' ? GREETING_TA : GREETING_EN;
    var bubble = document.getElementById('geminiSpeechBubble');
    if (bubble) bubble.textContent = '"' + greeting + '"';

    var statusEl = document.getElementById('geminiVoiceStatus');
    if (statusEl) {
      statusEl.textContent = currentLang === 'ta' ? '🎙️ ஜெமினி பேசுகிறது...' : '🎙️ Gemini is greeting you...';
    }

    // Immediately speak greeting, then automatically start listening!
    speakVoice(greeting, function() {
      if (statusEl) {
        statusEl.textContent = currentLang === 'ta' ? '🎙️ உங்கள் கேள்வியைக் கேளுங்கள்...' : '🎙️ Ask your question now...';
      }
      setTimeout(function() {
        startListening();
      }, 500);
    });
  };

  window.closeGeminiAssistant = function() {
    stopSpeaking();
    stopListening();
    if (restartListenTimeout) {
      clearTimeout(restartListenTimeout);
      restartListenTimeout = null;
    }
    var modal = document.getElementById('geminiAssistantModal');
    if (modal) modal.classList.add('hidden');
  };

  window.geminiToggleMic = function() {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  window.geminiStopSpeaking = function() {
    stopSpeaking();
    var statusEl = document.getElementById('geminiVoiceStatus');
    if (statusEl) {
      statusEl.textContent = currentLang === 'ta' ? 'குரல் நிறுத்தப்பட்டது.' : 'Voice stopped.';
    }
  };

  window.geminiToggleLanguage = function() {
    currentLang = currentLang === 'ta' ? 'en' : 'ta';
    updateLangButtonUI();

    var notify = currentLang === 'ta' ? 'நான் தமிழில் பேசுகிறேன். என்ன உதவி வேண்டும்?' : 'Switched to English. How can I help you?';
    var bubble = document.getElementById('geminiSpeechBubble');
    if (bubble) bubble.textContent = notify;
    speakVoice(notify, function() {
      setTimeout(startListening, 600);
    });
  };

  window.geminiToggleView = function() {
    isChatView = !isChatView;
    var voiceView = document.getElementById('geminiVoiceView');
    var chatView = document.getElementById('geminiChatView');
    var viewBtn = document.getElementById('geminiViewToggleBtn');

    if (isChatView) {
      if (voiceView) voiceView.classList.add('hidden');
      if (chatView) chatView.classList.remove('hidden');
      if (viewBtn) viewBtn.textContent = '🎙️';
      stopListening();
    } else {
      if (voiceView) voiceView.classList.remove('hidden');
      if (chatView) chatView.classList.add('hidden');
      if (viewBtn) viewBtn.textContent = '💬';
    }
  };

  window.geminiSendChatMessage = function() {
    var input = document.getElementById('geminiChatInput');
    if (!input || !input.value.trim()) return;
    var text = input.value.trim();
    input.value = '';
    handleUserMessage(text);
  };

  window.geminiSendQuickAction = function(text) {
    handleUserMessage(text);
  };

  // Auto-initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureAssistantElements);
  } else {
    ensureAssistantElements();
  }
})();
