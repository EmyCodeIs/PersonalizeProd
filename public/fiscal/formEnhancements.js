'use strict';

(() => {
  const FIELD_MESSAGES = {
    clientDocument: 'Informe o CPF ou CNPJ.',
    clientName: 'Informe o nome ou a razão social.',
    clientPostalCode: 'Informe um CEP com 8 dígitos.',
    clientStreet: 'Informe o logradouro.',
    clientNumber: 'Informe o número.',
    clientNeighborhood: 'Informe o bairro.',
    clientCity: 'Informe o município.',
    clientState: 'Informe a UF.',
    clientCityCode: 'Informe o código IBGE do município.',
    serviceCity: 'Informe o município da prestação.',
    serviceState: 'Informe a UF da prestação.',
    serviceCityCode: 'Informe o código IBGE da prestação.',
    serviceDescription: 'Descreva o serviço realizado.',
    serviceAmount: 'Informe um valor maior que zero.',
    competenceDate: 'Informe a data de competência.',
  };

  const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
  let lastCep = '';
  let cepTimer = null;

  function fieldContainer(input) {
    return input?.closest('.field') || input?.parentElement;
  }

  function removeMessage(input) {
    const container = fieldContainer(input);
    container?.querySelector(':scope > .field-error')?.remove();
  }

  function showMessage(input, message) {
    const container = fieldContainer(input);
    if (!container) return;
    let element = container.querySelector(':scope > .field-error');
    if (!element) {
      element = document.createElement('small');
      element.className = 'field-error';
      container.appendChild(element);
    }
    element.textContent = message;
  }

  function isValid(input) {
    const value = String(input?.value || '').trim();
    if (!input) return false;
    if (input.name === 'clientDocument') return [11, 14].includes(onlyDigits(value).length);
    if (input.name === 'clientPostalCode') return onlyDigits(value).length === 8;
    if (input.name === 'clientState' || input.name === 'serviceState') return value.length === 2;
    if (input.name === 'clientCityCode' || input.name === 'serviceCityCode') return onlyDigits(value).length === 7;
    if (input.name === 'serviceDescription') return value.length >= 5;
    if (input.name === 'serviceAmount') return Number(value) > 0;
    if (input.required) return Boolean(value) && input.checkValidity();
    return input.checkValidity();
  }

  function paintField(input, force = false) {
    if (!input?.name || input.type === 'hidden') return true;
    const valid = isValid(input);
    const shouldShow = force || input.classList.contains('is-invalid');
    input.classList.toggle('is-invalid', shouldShow && !valid);
    input.setAttribute('aria-invalid', shouldShow && !valid ? 'true' : 'false');
    if (shouldShow && !valid) showMessage(input, FIELD_MESSAGES[input.name] || 'Preencha este campo.');
    else removeMessage(input);
    return valid;
  }

  function validateService(form, force = false) {
    const input = form.elements.serviceProfileId;
    const grid = form.querySelector('.service-grid');
    if (!input || !grid) return true;
    const valid = Boolean(input.value);
    const shouldShow = force || grid.classList.contains('is-invalid');
    grid.classList.toggle('is-invalid', shouldShow && !valid);
    let error = grid.parentElement.querySelector('.service-field-error');
    if (shouldShow && !valid) {
      if (!error) {
        error = document.createElement('small');
        error.className = 'field-error service-field-error';
        grid.insertAdjacentElement('afterend', error);
      }
      error.textContent = 'Escolha um tipo de serviço.';
    } else {
      error?.remove();
    }
    return valid;
  }

  function validateForm(form) {
    const fields = [...form.querySelectorAll('input[required], textarea[required], select[required]')]
      .filter((input) => input.type !== 'hidden');
    let valid = true;
    for (const input of fields) if (!paintField(input, true)) valid = false;
    if (!validateService(form, true)) valid = false;
    if (!valid) {
      const first = form.querySelector('.is-invalid');
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      first?.focus?.();
      if (typeof notify === 'function') notify('Preencha os campos obrigatórios destacados em vermelho.', 'error');
    }
    return valid;
  }

  async function lookupCep(input) {
    const cep = onlyDigits(input.value);
    if (cep.length !== 8 || cep === lastCep) return;
    lastCep = cep;
    input.dataset.loading = 'true';
    try {
      const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      if (!response.ok) throw new Error('Não foi possível consultar o CEP.');
      const data = await response.json();
      if (data.erro) throw new Error('CEP não encontrado.');
      const form = input.form;
      const set = (name, value) => {
        const field = form?.elements[name];
        if (!field || !value) return;
        field.value = value;
        paintField(field, field.classList.contains('is-invalid'));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('clientStreet', data.logradouro);
      set('clientNeighborhood', data.bairro);
      set('clientCity', data.localidade);
      set('clientState', data.uf);
      set('clientCityCode', data.ibge);
      if (typeof notify === 'function') notify('Endereço preenchido pelo CEP. Confira o número e o complemento.');
      form?.elements.clientNumber?.focus();
    } catch (error) {
      lastCep = '';
      input.classList.add('is-invalid');
      showMessage(input, error.message);
      if (typeof notify === 'function') notify(error.message, 'error');
    } finally {
      delete input.dataset.loading;
    }
  }

  document.addEventListener('input', (event) => {
    const input = event.target.closest?.('#invoice-form input, #invoice-form textarea, #invoice-form select');
    if (!input) return;
    paintField(input, input.classList.contains('is-invalid'));
    if (input.name === 'clientPostalCode') {
      clearTimeout(cepTimer);
      const cep = onlyDigits(input.value);
      if (cep.length < 8) lastCep = '';
      if (cep.length === 8) cepTimer = setTimeout(() => lookupCep(input), 250);
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-service]')) {
      const form = event.target.closest('#invoice-form');
      if (form) setTimeout(() => validateService(form), 0);
    }
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target.closest?.('#invoice-form');
    if (!form) return;
    if (!validateForm(form)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const observer = new MutationObserver(() => {
    const login = document.querySelector('#login-form');
    if (login && !login.dataset.personalizeDefaults) {
      login.dataset.personalizeDefaults = 'true';
      if (login.elements.email) login.elements.email.value = 'contato@personalizeseuambiente.com.br';
      if (login.elements.password) login.elements.password.value = '2580';
    }
    const cep = document.querySelector('#invoice-form [name="clientPostalCode"]');
    if (cep && !cep.dataset.cepReady) {
      cep.dataset.cepReady = 'true';
      cep.setAttribute('inputmode', 'numeric');
      cep.setAttribute('maxlength', '9');
      cep.setAttribute('autocomplete', 'postal-code');
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
