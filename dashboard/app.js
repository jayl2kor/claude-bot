/**
 * Dashboard client-side application.
 * Connects to SSE for real-time updates, renders pet cards and detail views.
 * Uses Chart.js for growth timeline and activity heatmap.
 */

(function () {
  'use strict';

  // ---- State ----
  let selectedPetId = null;
  let knowledgePage = 1;
  let knowledgeQuery = '';
  let growthChart = null;
  let activityChart = null;
  let eventSource = null;

  // ---- DOM References ----
  const petGrid = document.getElementById('pet-grid');
  const detailPanel = document.getElementById('detail-panel');
  const detailName = document.getElementById('detail-name');
  const detailStatus = document.getElementById('detail-status');
  const closeDetail = document.getElementById('close-detail');
  const connectionStatus = document.getElementById('connection-status');

  // ---- Init ----
  function init() {
    fetchPets();
    connectSSE();
    bindEvents();
  }

  // ---- Events ----
  function bindEvents() {
    closeDetail.addEventListener('click', function () {
      detailPanel.classList.add('hidden');
      selectedPetId = null;
    });

    // Tab switching
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var tabName = this.dataset.tab;
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        this.classList.add('active');
        document.getElementById('tab-' + tabName).classList.add('active');

        if (tabName === 'knowledge') loadKnowledge();
        if (tabName === 'activity') loadActivity();
        if (tabName === 'reflections') loadReflections();
        if (tabName === 'persona') loadPersona();
      });
    });

    // Knowledge search
    document.getElementById('knowledge-search-btn').addEventListener('click', function () {
      knowledgeQuery = document.getElementById('knowledge-search').value;
      knowledgePage = 1;
      loadKnowledge();
    });

    document.getElementById('knowledge-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        knowledgeQuery = this.value;
        knowledgePage = 1;
        loadKnowledge();
      }
    });

    // Pagination
    document.getElementById('knowledge-prev').addEventListener('click', function () {
      if (knowledgePage > 1) {
        knowledgePage--;
        loadKnowledge();
      }
    });

    document.getElementById('knowledge-next').addEventListener('click', function () {
      knowledgePage++;
      loadKnowledge();
    });
  }

  // ---- SSE ----
  function connectSSE() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/events');

    eventSource.addEventListener('status', function (e) {
      try {
        var pets = JSON.parse(e.data);
        renderPetCards(pets);
      } catch (_) { /* ignore parse errors */ }
    });

    eventSource.addEventListener('stats', function (e) {
      try {
        var statsMap = JSON.parse(e.data);
        if (selectedPetId && statsMap[selectedPetId]) {
          renderOverview(statsMap[selectedPetId]);
        }
      } catch (_) { /* ignore parse errors */ }
    });

    eventSource.addEventListener('open', function () {
      connectionStatus.className = 'status-dot online';
      connectionStatus.title = 'Connected';
    });

    eventSource.addEventListener('error', function () {
      connectionStatus.className = 'status-dot offline';
      connectionStatus.title = 'Disconnected';

      // Auto-reconnect after 5s (EventSource does this automatically,
      // but we update UI state)
      setTimeout(function () {
        if (eventSource.readyState === EventSource.CLOSED) {
          connectSSE();
        }
      }, 5000);
    });
  }

  // ---- Fetch Helpers ----
  function fetchJSON(url) {
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (body) {
        if (!body.success && body.error) {
          throw new Error(body.error);
        }
        return body;
      });
  }

  // ---- Pets ----
  function fetchPets() {
    fetchJSON('/api/pets')
      .then(function (body) { renderPetCards(body.data || []); })
      .catch(function () { petGrid.innerHTML = '<p class="placeholder">Failed to load pets</p>'; });
  }

  function renderPetCards(pets) {
    if (!pets || pets.length === 0) {
      petGrid.innerHTML = '<p class="placeholder">No pets discovered</p>';
      return;
    }

    petGrid.innerHTML = pets.map(function (pet) {
      var statusClass = pet.isOnline ? 'online' : 'offline';
      var statusLabel = pet.isOnline ? 'Online' : 'Offline';
      return '<div class="pet-card" data-pet-id="' + pet.id + '">' +
        '<div class="pet-card-header">' +
        '<span class="status-dot ' + statusClass + '" title="' + statusLabel + '"></span>' +
        '<h3>' + escapeHtml(pet.name) + '</h3>' +
        '</div>' +
        '<div class="pet-card-stats">' +
        '<span>Knowledge: ' + pet.knowledgeCount + '</span>' +
        '<span>Relations: ' + pet.relationshipCount + '</span>' +
        '</div>' +
        '</div>';
    }).join('');

    // Bind click handlers
    petGrid.querySelectorAll('.pet-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var petId = this.dataset.petId;
        openPetDetail(petId, pets.find(function (p) { return p.id === petId; }));
      });
    });
  }

  // ---- Detail Panel ----
  function openPetDetail(petId, petSummary) {
    selectedPetId = petId;
    detailName.textContent = petSummary ? petSummary.name : petId;
    detailStatus.className = 'status-dot ' + (petSummary && petSummary.isOnline ? 'online' : 'offline');
    detailPanel.classList.remove('hidden');

    // Reset to overview tab
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
    document.querySelector('[data-tab="overview"]').classList.add('active');
    document.getElementById('tab-overview').classList.add('active');

    // Load stats
    fetchJSON('/api/pets/' + petId + '/stats')
      .then(function (body) { renderOverview(body.data); })
      .catch(function () { /* stats failed */ });
  }

  function renderOverview(stats) {
    if (!stats) return;

    document.getElementById('stat-knowledge').textContent = stats.knowledge.total;
    document.getElementById('stat-relationships').textContent = stats.relationships.total;
    document.getElementById('stat-reflections').textContent = stats.reflections.total;
    document.getElementById('stat-sessions').textContent = stats.activity.totalSessions;

    // Latest insight
    var insightCard = document.getElementById('latest-insight');
    if (stats.reflections.latestInsight) {
      document.getElementById('insight-text').textContent = stats.reflections.latestInsight;
      insightCard.classList.remove('hidden');
    } else {
      insightCard.classList.add('hidden');
    }

    // Load growth chart
    loadGrowthChart();
  }

  // ---- Growth Chart ----
  function loadGrowthChart() {
    if (!selectedPetId) return;

    fetchJSON('/api/pets/' + selectedPetId + '/activity')
      .then(function (body) {
        var growth = (body.data && body.data.growth) || [];
        renderGrowthChart(growth);
      })
      .catch(function () { /* growth chart failed */ });
  }

  function renderGrowthChart(data) {
    var canvas = document.getElementById('growth-chart');
    var ctx = canvas.getContext('2d');

    if (growthChart) {
      growthChart.destroy();
    }

    if (!data || data.length === 0) {
      growthChart = null;
      return;
    }

    growthChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(function (d) { return d.date; }),
        datasets: [
          {
            label: 'Knowledge',
            data: data.map(function (d) { return d.knowledgeCount; }),
            borderColor: '#e94560',
            backgroundColor: 'rgba(233, 69, 96, 0.1)',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Relationships',
            data: data.map(function (d) { return d.relationshipCount; }),
            borderColor: '#4ade80',
            backgroundColor: 'rgba(74, 222, 128, 0.1)',
            fill: true,
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#aab' } }
        },
        scales: {
          x: { ticks: { color: '#778' }, grid: { color: '#2a2a4e' } },
          y: { ticks: { color: '#778' }, grid: { color: '#2a2a4e' }, beginAtZero: true }
        }
      }
    });
  }

  // ---- Knowledge ----
  function loadKnowledge() {
    if (!selectedPetId) return;

    var url = '/api/pets/' + selectedPetId + '/knowledge?page=' + knowledgePage + '&limit=20';
    if (knowledgeQuery) url += '&q=' + encodeURIComponent(knowledgeQuery);

    fetchJSON(url)
      .then(function (body) {
        renderKnowledgeList(body.data || [], body.meta || {});
      })
      .catch(function () {
        document.getElementById('knowledge-list').innerHTML =
          '<p class="placeholder">Failed to load knowledge</p>';
      });
  }

  function renderKnowledgeList(entries, meta) {
    var list = document.getElementById('knowledge-list');

    if (entries.length === 0) {
      list.innerHTML = '<p class="placeholder">No knowledge entries found</p>';
    } else {
      list.innerHTML = entries.map(function (k) {
        var date = new Date(k.createdAt).toLocaleDateString();
        var sourceLabel = k.source === 'taught' ? 'Taught' : k.source === 'inferred' ? 'Inferred' : 'Corrected';
        return '<div class="knowledge-item">' +
          '<div class="topic">' + escapeHtml(k.topic) + '</div>' +
          '<div class="content">' + escapeHtml(k.content) + '</div>' +
          '<div class="meta">' +
          '<span>' + sourceLabel + '</span>' +
          '<span>Confidence: ' + Math.round(k.confidence * 100) + '%</span>' +
          '<span>' + date + '</span>' +
          (k.tags && k.tags.length ? '<span>Tags: ' + k.tags.map(escapeHtml).join(', ') + '</span>' : '') +
          '</div></div>';
      }).join('');
    }

    // Update pagination
    var total = meta.total || 0;
    var limit = meta.limit || 20;
    var totalPages = Math.max(1, Math.ceil(total / limit));
    document.getElementById('knowledge-page-info').textContent = 'Page ' + knowledgePage + ' of ' + totalPages;
    document.getElementById('knowledge-prev').disabled = knowledgePage <= 1;
    document.getElementById('knowledge-next').disabled = knowledgePage >= totalPages;
  }

  // ---- Activity ----
  function loadActivity() {
    if (!selectedPetId) return;

    fetchJSON('/api/pets/' + selectedPetId + '/activity')
      .then(function (body) {
        var heatmap = (body.data && body.data.heatmap) || [];
        renderActivityChart(heatmap);
      })
      .catch(function () { /* activity chart failed */ });
  }

  function renderActivityChart(data) {
    var canvas = document.getElementById('activity-chart');
    var ctx = canvas.getContext('2d');

    if (activityChart) {
      activityChart.destroy();
    }

    if (!data || data.length === 0) {
      activityChart = null;
      return;
    }

    activityChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(function (d) { return d.hour + ':00'; }),
        datasets: [{
          label: 'Activity',
          data: data.map(function (d) { return d.count; }),
          backgroundColor: 'rgba(233, 69, 96, 0.6)',
          borderColor: '#e94560',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#aab' } }
        },
        scales: {
          x: { ticks: { color: '#778' }, grid: { color: '#2a2a4e' } },
          y: { ticks: { color: '#778' }, grid: { color: '#2a2a4e' }, beginAtZero: true }
        }
      }
    });
  }

  // ---- Reflections ----
  function loadReflections() {
    if (!selectedPetId) return;

    fetchJSON('/api/pets/' + selectedPetId + '/reflections?limit=10')
      .then(function (body) {
        renderReflections(body.data || []);
      })
      .catch(function () {
        document.getElementById('reflections-list').innerHTML =
          '<p class="placeholder">Failed to load reflections</p>';
      });
  }

  function renderReflections(reflections) {
    var list = document.getElementById('reflections-list');

    if (reflections.length === 0) {
      list.innerHTML = '<p class="placeholder">No reflections yet</p>';
      return;
    }

    list.innerHTML = reflections.map(function (r) {
      var date = new Date(r.createdAt).toLocaleString();
      var insightsList = r.insights && r.insights.length
        ? '<ul class="insights">' + r.insights.map(function (i) {
            return '<li>' + escapeHtml(i) + '</li>';
          }).join('') + '</ul>'
        : '';
      return '<div class="reflection-item">' +
        '<div class="date">' + date + '</div>' +
        '<div class="summary">' + escapeHtml(r.summary) + '</div>' +
        insightsList +
        '</div>';
    }).join('');
  }

  // ---- Persona ----
  function loadPersona() {
    if (!selectedPetId) return;

    fetchJSON('/api/pets/' + selectedPetId + '/persona')
      .then(function (body) {
        renderPersona(body.data);
      })
      .catch(function () {
        document.getElementById('persona-info').innerHTML =
          '<p class="placeholder">Failed to load persona</p>';
      });
  }

  function renderPersona(persona) {
    var info = document.getElementById('persona-info');

    if (!persona) {
      info.innerHTML = '<p class="placeholder">No persona data</p>';
      return;
    }

    var toneMap = { casual: 'Casual', formal: 'Formal', playful: 'Playful' };
    var fields = [
      { label: 'Name', value: persona.name },
      { label: 'Personality', value: persona.personality || '-' },
      { label: 'Tone', value: toneMap[persona.tone] || persona.tone },
      { label: 'Values', value: (persona.values || []).join(', ') || '-' },
      { label: 'Constraints', value: (persona.constraints || []).join(', ') || 'None' }
    ];

    info.innerHTML = fields.map(function (f) {
      return '<div class="persona-field">' +
        '<div class="label">' + f.label + '</div>' +
        '<div class="value">' + escapeHtml(f.value) + '</div>' +
        '</div>';
    }).join('');
  }

  // ---- Utilities ----
  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Start ----
  document.addEventListener('DOMContentLoaded', init);
})();
