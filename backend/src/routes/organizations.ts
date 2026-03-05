import { createCrudRouter } from '../helpers/crudRouter';

export default createCrudRouter({
  table: 'organizations',
  requiredFields: ['name'],
  defaultValues: { color: '#6366f1' },
  updateFields: ['name', 'color'],
});
