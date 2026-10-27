document.querySelector('[data-testid="runtime"]').textContent = `Loaded at ${new Date().toISOString()}`;

const card = document.querySelector('#card');
document.querySelector('#cards').append(card.content.cloneNode(true));
